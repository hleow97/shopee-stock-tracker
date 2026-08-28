#!/usr/bin/env node
'use strict';

/**
 * Shopee restock tracker.
 *
 * Watches Shopee listings and alerts on the transition
 * "not purchasable" -> "purchasable".
 *
 * No login and no API key required. Shopee's PDP API (/api/v4/pdp/get_pc)
 * returns error 90309999 for logged-out callers, but the server-rendered
 * product HTML still embeds the full PDP payload, and that works anonymously.
 *
 * Reading the payload correctly matters:
 *   - `stock` is MASKED when logged out. Every variation reports 10, including
 *     sold-out ones. Never treat it as a stock count.
 *   - `price` / `historical_sold` are nulled out when logged out. Also useless.
 *   - `is_grayout` and `is_clickable` ARE truthful per variation. Verified
 *     against a multi-variation listing where only the genuinely available
 *     options came back is_grayout:false / is_clickable:true while the rest
 *     came back is_grayout:true.
 *
 * So: available === at least one variation with is_grayout false / clickable true.
 *
 * Usage:
 *   node tracker.js              check once, alert on restock (for Task Scheduler)
 *   node tracker.js --status     print current state, never alert
 *   node tracker.js --watch 15   stay in foreground, re-check every 15 minutes
 *   node tracker.js --test-alert fire a test notification and exit
 *   node tracker.js --reset      clear saved state (next run re-baselines)
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = __dirname;
const ITEMS_FILE = path.join(DIR, 'items.json');
// Secrets live outside items.json so the watch list stays safe to commit.
const SECRETS_FILE = path.join(DIR, 'secrets.local.json');
const STATE_FILE = path.join(DIR, 'state.json');
const LOG_FILE = path.join(DIR, 'restock.log');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const EOL = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);

// ---------------------------------------------------------------- utilities

function log(line) {
  const stamped = '[' + new Date().toISOString() + '] ' + line;
  console.log(stamped);
  try {
    fs.appendFileSync(LOG_FILE, stamped + EOL);
  } catch (err) {
    console.error('could not write log:', err.message);
  }
}

function readJson(file, fallback) {
  try {
    // Strip a UTF-8 BOM: Notepad and PowerShell's Out-File both add one, and
    // JSON.parse rejects it.
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    return JSON.parse(text);
  } catch (err) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + EOL, 'utf8');
}

// A lock file makes overlapping checks impossible regardless of how they were
// launched — scheduled task, manual run, or --watch. Without it, two concurrent
// runs both read "unavailable", both see the restock, and both alert; worse,
// their state.json writes race and one can lose the availability record,
// causing a duplicate alert on a later run.
const LOCK_FILE = path.join(DIR, '.lock');
const LOCK_STALE_MS = 10 * 60 * 1000;

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // Someone holds it. Reclaim only if it is old enough that the holder
      // must have crashed — a live run should never be interrupted.
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS;
      } catch (statErr) {
        stale = true; // vanished between open and stat; try again
      }
      if (!stale) return false;
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch (unlinkErr) {
        /* another process beat us to it */
      }
    }
  }
  return false;
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (err) {
    /* already gone */
  }
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function productUrl(shopId, itemId) {
  return 'https://shopee.com.my/product/' + shopId + '/' + itemId;
}

// ------------------------------------------------------------- page parsing

/**
 * The SSR HTML carries the PDP payload keyed as "<shopId>/<itemId>":{...}.
 * Brace-match it out rather than regexing, because the blob is ~1MB of
 * minified JSON with plenty of nested braces inside strings.
 */
function extractPayload(html, shopId, itemId) {
  const key = '"' + shopId + '/' + itemId + '":';
  const at = html.indexOf(key);
  if (at < 0) return null;

  const start = at + key.length;
  if (html[start] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let p = start; p < html.length; p++) {
    const c = html[p];

    if (inString) {
      if (escaped) escaped = false;
      else if (c === BACKSLASH) escaped = true;
      else if (c === '"') inString = false;
      continue;
    }

    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, p + 1));
        } catch (err) {
          return null;
        }
      }
    }
  }
  return null;
}

function evaluate(payload) {
  const item = payload && payload.item;
  if (!item) return { ok: false, reason: 'payload had no item object' };

  const models = Array.isArray(item.models) ? item.models : [];
  const buyable = models.filter(function (m) {
    return m.is_grayout === false || m.is_clickable === true;
  });

  // A delisted / banned / deleted listing should not be read as "sold out",
  // and must never be read as available.
  const listingLive = item.item_status === 'normal' && item.status === 1;

  return {
    ok: true,
    title: item.title || '(untitled)',
    listingLive: listingLive,
    itemStatus: item.item_status,
    available: listingLive && buyable.length > 0,
    variationCount: models.length,
    buyableNames: buyable.map(function (m) {
      return m.name || '(single variation)';
    }),
    isPreOrder: !!item.is_pre_order,
    estimatedDays: item.estimated_days === undefined ? null : item.estimated_days,
  };
}

/** Resolve the public URL for a watch entry, whichever site it belongs to. */
function watchUrl(watch) {
  if (watch.site === 'pbandai') {
    return require('./pbandai.js').itemUrl(watch.itemCode, watch.area);
  }
  return productUrl(watch.shopId, watch.itemId);
}

async function checkItem(watch) {
  if (watch.site === 'pbandai') {
    // P-Bandai needs a real browser (Akamai bot protection), which is not
    // viable from CI datacenter IPs - they get the waiting-room page.
    if (process.env.SHOPEE_TRACKER_SKIP_BROWSER === '1') {
      return { ok: false, reason: 'browser check skipped (SHOPEE_TRACKER_SKIP_BROWSER=1)' };
    }
    return require('./pbandai.js').checkPBandai(watch);
  }
  return checkShopee(watch);
}

async function checkShopee(watch) {
  const url = productUrl(watch.shopId, watch.itemId);
  let html;

  // Shopee occasionally serves a login-wall shell instead of the product page.
  // Retry a couple of times before treating the result as unknown.
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      html = await res.text();
      const payload = extractPayload(html, watch.shopId, watch.itemId);
      if (payload) return evaluate(payload);
      lastError = new Error('product payload not found (login wall or delisted)');
    } catch (err) {
      lastError = err;
    }
    if (attempt < 3) await sleep(3000 * attempt);
  }

  return { ok: false, reason: lastError ? lastError.message : 'unknown failure' };
}

// ----------------------------------------------------------------- alerting

/**
 * Webhook settings come from, in order: environment (how CI supplies the
 * secret), secrets.local.json (gitignored, for this machine), then items.json
 * (legacy). Keeping the URL out of items.json means the watch list can be
 * committed to a public repo safely.
 */
function resolveWebhook(config) {
  const secrets = readJson(SECRETS_FILE, {}) || {};
  return {
    url: process.env.SHOPEE_WEBHOOK_URL || secrets.webhookUrl || config.webhookUrl || null,
    mention:
      process.env.SHOPEE_WEBHOOK_MENTION ||
      secrets.webhookMention ||
      config.webhookMention ||
      null,
  };
}

function notifyWindows(title, message) {
  // Desktop toasts are Windows-only; on a CI runner or Linux box the Discord
  // webhook is the alert channel instead.
  if (process.platform !== 'win32') return;

  // Title and body travel via env vars so nothing in the product name can
  // break out of the PowerShell command line.
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    'Add-Type -AssemblyName System.Drawing;',
    '$n = New-Object System.Windows.Forms.NotifyIcon;',
    '$n.Icon = [System.Drawing.SystemIcons]::Information;',
    '$n.BalloonTipTitle = $env:SHOPEE_ALERT_TITLE;',
    '$n.BalloonTipText = $env:SHOPEE_ALERT_BODY;',
    '$n.Visible = $true;',
    '$n.ShowBalloonTip(30000);',
    'Start-Sleep -Seconds 15;',
    '$n.Dispose();',
  ].join(' ');

  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      {
        detached: true,
        stdio: 'ignore',
        env: Object.assign({}, process.env, {
          SHOPEE_ALERT_TITLE: title,
          SHOPEE_ALERT_BODY: message,
        }),
      }
    );
    child.unref();
  } catch (err) {
    log('desktop notification failed: ' + err.message);
  }
}

function openInBrowser(url) {
  if (process.platform !== 'win32') return;
  try {
    const child = spawn('cmd.exe', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    log('could not open browser: ' + err.message);
  }
}

/**
 * Different services want different payload shapes, so match the shape to the
 * host rather than shotgunning fields and hoping one sticks. Discord gets a
 * real embed so the product title is a tappable link on mobile.
 */
function buildWebhookBody(webhookUrl, alert) {
  const url = String(webhookUrl);
  const plain = alert.headline + ': ' + alert.title + EOL + alert.url;

  const isDiscord =
    url.indexOf('discord.com/api/webhooks') !== -1 ||
    url.indexOf('discordapp.com/api/webhooks') !== -1;

  if (isDiscord) {
    const body = {
      username: 'Shopee tracker',
      embeds: [
        {
          title: alert.title.slice(0, 250),
          url: alert.url,
          description: alert.headline,
          color: alert.good === false ? 0x9aa0a6 : 0x2ecc71,
          footer: { text: 'Shopee restock tracker' },
          timestamp: new Date().toISOString(),
        },
      ],
    };
    // A mention is what actually triggers a push notification on phones.
    // allowed_mentions must explicitly permit it, otherwise Discord can render
    // "@everyone" as inert text and no push is sent.
    if (alert.mention) {
      body.content = alert.mention;
      body.allowed_mentions = { parse: ['everyone', 'roles', 'users'] };
    }
    return body;
  }

  if (url.indexOf('hooks.slack.com') !== -1) return { text: plain };

  return { text: plain, content: plain };
}

async function postWebhook(webhookUrl, alert) {
  if (!webhookUrl) return;
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildWebhookBody(webhookUrl, alert)),
    });
    // Discord returns 204 No Content on success.
    if (res.ok) {
      log('webhook delivered (' + res.status + ')');
    } else {
      const detail = await res.text().catch(function () {
        return '';
      });
      log('webhook rejected (' + res.status + ') ' + detail.slice(0, 200));
    }
  } catch (err) {
    log('webhook failed: ' + err.message);
  }
}

// --------------------------------------------------------------------- main

async function runOnce(config, options) {
  if (!acquireLock()) {
    log('another check is already running; skipping this one');
    return readJson(STATE_FILE, {});
  }
  try {
    return await runOnceLocked(config, options);
  } finally {
    releaseLock();
  }
}

async function runOnceLocked(config, options) {
  const state = readJson(STATE_FILE, {});
  const statusOnly = !!options.statusOnly;

  for (let i = 0; i < config.items.length; i++) {
    const watch = config.items[i];
    const key = watch.id || watch.shopId + '/' + watch.itemId;
    const label = watch.label || key;
    const url = watchUrl(watch);

    const previous = state[key] || {};

    // Some sites (P-Bandai) block aggressive polling. Let an item opt into a
    // slower cadence than the scheduler's, instead of running every pass.
    if (watch.minIntervalMinutes && previous.lastCheckedAt) {
      const sinceMs = Date.now() - new Date(previous.lastCheckedAt).getTime();
      if (sinceMs < watch.minIntervalMinutes * 60 * 1000) {
        continue;
      }
    }

    if (i > 0) await sleep(2000 + Math.floor(Math.random() * 3000)); // be polite

    const result = await checkItem(watch);

    if (!result.ok) {
      // Never let a fetch failure flip or clear a known state.
      log('CHECK FAILED  ' + label + ' :: ' + result.reason);
      state[key] = Object.assign({}, previous, {
        lastCheckedAt: new Date().toISOString(),
        lastError: result.reason,
        consecutiveErrors: (previous.consecutiveErrors || 0) + 1,
      });
      continue;
    }

    const wasAvailable = previous.available;
    const detail =
      result.available
        ? 'AVAILABLE (' + result.buyableNames.join(', ') + ')'
        : result.listingLive
        ? 'not purchasable'
        : 'listing not live (item_status=' + result.itemStatus + ')';

    log(label + ' :: ' + detail);

    state[key] = {
      label: label,
      url: url,
      title: result.title,
      available: result.available,
      listingLive: result.listingLive,
      variationCount: result.variationCount,
      buyableNames: result.buyableNames,
      isPreOrder: result.isPreOrder,
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
      consecutiveErrors: 0,
      firstSeenAvailableAt: result.available
        ? previous.firstSeenAvailableAt || new Date().toISOString()
        : null,
    };

    const isRestock = result.available && wasAvailable === false;
    const isFirstRunAvailable = result.available && wasAvailable === undefined;

    if (statusOnly) continue;

    if (isRestock || isFirstRunAvailable) {
      const headline = isRestock ? 'BACK IN STOCK' : 'Available now';
      const body = result.title + EOL + url;

      log('*** ' + headline + ' *** ' + label);
      notifyWindows('Shopee: ' + headline, body);
      const hook = resolveWebhook(config);
      await postWebhook(hook.url, {
        headline: headline,
        title: result.title,
        url: url,
        good: true,
        mention: hook.mention,
      });

      if (watch.openBrowserOnRestock) openInBrowser(url);
    } else if (!result.available && wasAvailable === true) {
      log('--- went out of stock again --- ' + label);
      notifyWindows('Shopee: sold out again', result.title);
    }
  }

  writeJson(STATE_FILE, state);
  return state;
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--test-alert')) {
    notifyWindows('Shopee tracker test', 'Notifications are working.');
    log('test alert sent');
    return;
  }

  // Renders the exact notification a real restock produces, using the real
  // product title and URL, without touching state or waiting for a restock.
  //   node tracker.js --preview-alert [item-id]
  if (argv.includes('--preview-alert')) {
    const config = readJson(ITEMS_FILE, null);
    if (!config || !Array.isArray(config.items) || config.items.length === 0) {
      console.error('No watch list at ' + ITEMS_FILE);
      process.exitCode = 1;
      return;
    }

    const wanted = argv[argv.indexOf('--preview-alert') + 1];
    const watch =
      (wanted && config.items.find(function (i) { return i.id === wanted; })) ||
      config.items[0];

    const key = watch.id || watch.shopId + '/' + watch.itemId;
    const saved = (readJson(STATE_FILE, {}) || {})[key] || {};
    const title = saved.title || watch.label || key;
    const url = watchUrl(watch);

    console.log('Previewing the alert for: ' + (watch.label || key));
    console.log('');
    console.log('  Toast title: Shopee: BACK IN STOCK');
    console.log('  Toast body : ' + title);
    console.log('               ' + url);
    console.log('  Log line   : *** BACK IN STOCK *** ' + (watch.label || key));
    console.log(
      '  Browser    : ' +
        (watch.openBrowserOnRestock ? 'opens ' + url : 'not opened (disabled for this item)')
    );

    notifyWindows('Shopee: BACK IN STOCK', title + EOL + url);
    return;
  }

  // Sends a real message through the configured webhook so delivery can be
  // confirmed without waiting for a restock.
  if (argv.includes('--test-webhook')) {
    const config = readJson(ITEMS_FILE, null);
    if (!config) {
      console.error('No config at ' + ITEMS_FILE);
      process.exitCode = 1;
      return;
    }
    const hook = resolveWebhook(config);
    if (!hook.url) {
      console.error('No webhook configured.');
      console.error('Set SHOPEE_WEBHOOK_URL, or add webhookUrl to ' + SECRETS_FILE);
      process.exitCode = 1;
      return;
    }

    const watch = config.items && config.items[0];
    const sample = watch
      ? { title: watch.label, url: watchUrl(watch) }
      : { title: 'Test item', url: 'https://shopee.com.my' };

    console.log('Posting a test message to the configured webhook...');
    await postWebhook(hook.url, {
      headline: 'Webhook test - this is what a restock alert will look like',
      title: sample.title,
      url: sample.url,
      good: true,
      mention: hook.mention,
    });
    console.log('Done. Check your Discord channel.');
    return;
  }

  if (argv.includes('--reset')) {
    try {
      fs.unlinkSync(STATE_FILE);
    } catch (err) {
      /* already gone */
    }
    log('state cleared');
    return;
  }

  const config = readJson(ITEMS_FILE, null);
  if (!config || !Array.isArray(config.items) || config.items.length === 0) {
    console.error('No watch list. Expected items.json with a non-empty "items" array at ' + ITEMS_FILE);
    process.exitCode = 1;
    return;
  }

  const statusOnly = argv.includes('--status');

  const watchAt = argv.indexOf('--watch');
  if (watchAt >= 0) {
    const minutes = Number(argv[watchAt + 1]);
    const interval = Number.isFinite(minutes) && minutes >= 1 ? minutes : 15;
    log('watching every ' + interval + ' min (Ctrl+C to stop)');
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await runOnce(config, { statusOnly: statusOnly });
      await sleep(interval * 60 * 1000);
    }
  }

  const state = await runOnce(config, { statusOnly: statusOnly });

  if (statusOnly) {
    console.log(EOL + 'Current state:');
    Object.keys(state).forEach(function (k) {
      const s = state[k];
      console.log(
        '  ' +
          (s.available ? '[IN STOCK]    ' : '[unavailable] ') +
          (s.label || k) +
          (s.lastError ? '  (last error: ' + s.lastError + ')' : '')
      );
    });
  }
}

if (require.main === module) {
  main().catch(function (err) {
    log('fatal: ' + (err && err.stack ? err.stack : err));
    process.exitCode = 1;
  });
}

// Exported so the parsing and decision logic can be tested offline against
// saved page fixtures, with no network and no notifications.
module.exports = { extractPayload: extractPayload, evaluate: evaluate };
