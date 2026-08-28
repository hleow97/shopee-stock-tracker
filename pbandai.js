'use strict';

/**
 * P-Bandai (Premium Bandai) stock checker.
 *
 * Unlike Shopee, P-Bandai cannot be read with a plain HTTP fetch. The product
 * page is a Vue SPA behind Akamai Bot Manager: a server-side fetch returns only
 * a shell with no PRELOAD_DATA and no product code, and hitting their JSON
 * endpoints directly earns a 503 "NETWORK CONGESTION" waiting-room page within
 * a couple of requests. So this drives a real headless browser.
 *
 * Availability signal, verified against a live sold-out listing: the purchase
 * button carries its state in its class list.
 *
 *   sold out : <button class="p-button p-button--red is-noActive">SORRY, OUT OF STOCK</button>
 *   buyable  : same button without `is-noActive`, reading ADD TO CART
 *
 * The quantity steppers (.c-input-quantity__inc/dec) are `disabled` while sold
 * out, which corroborates it independently.
 *
 * Because this is heavier and more rate-limit-sensitive than the Shopee check,
 * it should run at a gentler interval and never from a datacenter IP.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function itemUrl(itemCode, area) {
  return 'https://p-bandai.com/' + (area || 'sg') + '/item/' + itemCode;
}

async function checkPBandai(watch) {
  let chromium;
  try {
    chromium = require('playwright').chromium;
  } catch (err) {
    return {
      ok: false,
      reason: 'playwright not installed (run: npm install playwright && npx playwright install chromium)',
    };
  }

  const url = itemUrl(watch.itemCode, watch.area);
  let browser = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: UA,
      locale: 'en-US',
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    // Do NOT block images/fonts here. Intercepting requests stops the page
    // hydrating at all - measured directly: with blocking the purchase button
    // never appears (waitForSelector times out, zero .p-button--red found);
    // without it, the button is there. Presumably the bot-detection script is
    // unhappy with request interception. The check is slower but it works.
    // P-Bandai throttles back-to-back requests, and a slow load leaves the
    // purchase button un-rendered. Retry rather than reporting a false failure.
    let found = false;
    for (let attempt = 1; attempt <= 3 && !found; attempt++) {
      if (attempt > 1) await page.waitForTimeout(6000);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForSelector('.p-button--red', { timeout: 30000 });
        found = true;
      } catch (err) {
        /* try again */
      }
    }

    const data = await page.evaluate(function () {
      const body = document.body ? document.body.innerText : '';

      // The sold-out state is confirmed markup:
      //   <button class="p-button p-button--red is-noActive">SORRY, OUT OF STOCK</button>
      // The buyable state is NOT confirmed - P-Bandai IP-blocked verification
      // against an in-stock listing. So do not depend on any single class:
      // look for purchase affordances by text and by control state as well.
      const reds = Array.prototype.slice.call(document.querySelectorAll('.p-button--red'));
      const primaryRed =
        reds.filter(function (b) {
          return !b.closest('.c-items-fixed-btn');
        })[0] || reds[0] || null;

      const clickable = Array.prototype.slice.call(
        document.querySelectorAll('button, a, [class*="button"], [class*="btn"]')
      );
      const addToCart = clickable.filter(function (e) {
        return (
          /ADD TO CART|PROCEED TO|BUY NOW|PRE-ORDER NOW/i.test((e.innerText || '').trim()) &&
          e.disabled !== true &&
          !/is-noActive/.test((e.className || '').toString())
        );
      });

      const inc = document.querySelector('.c-input-quantity__inc');

      return {
        blocked:
          /NETWORK CONGESTION|PAGE NOT AVAILABLE|PAGE NOT FOUND/i.test(document.title) ||
          /NETWORK CONGESTION|PAGE NOT AVAILABLE/i.test(body),
        purchaseAreaFound: !!primaryRed || !!inc || addToCart.length > 0,
        redText: primaryRed ? (primaryRed.innerText || '').trim() : null,
        redInactive: primaryRed ? /is-noActive/.test(primaryRed.className || '') : null,
        addToCartCount: addToCart.length,
        addToCartText: addToCart.length ? (addToCart[0].innerText || '').trim() : null,
        qtyEnabled: inc ? inc.disabled === false : null,
        soldOutInBody: /OUT OF STOCK|SOLD OUT/i.test(body),
        title: (function () {
          const h1 = document.querySelector('h1');
          return (h1 ? h1.innerText : document.title || '').trim();
        })(),
        preOrderCloses: (function () {
          const m = body.match(/PRE-ORDERS CLOSE\s*([^\n]+)/i);
          return m ? m[1].trim() : null;
        })(),
      };
    });

    if (data.blocked) {
      return { ok: false, reason: 'P-Bandai served a block/waiting-room page' };
    }
    if (!data.purchaseAreaFound) {
      return { ok: false, reason: 'purchase area not found (page structure changed or blocked)' };
    }

    // Positive evidence of buyability, in order of confidence.
    const hasAddToCart = data.addToCartCount > 0;
    const redSaysSoldOut = data.redInactive === true || /OUT OF STOCK|SOLD OUT/i.test(data.redText || '');
    const redSaysBuyable = data.redInactive === false && !/OUT OF STOCK|SOLD OUT/i.test(data.redText || '');

    let available;
    if (hasAddToCart || redSaysBuyable) available = true;
    else if (redSaysSoldOut || data.soldOutInBody) available = false;
    else if (data.qtyEnabled === true) available = true;
    else available = false;

    return {
      ok: true,
      title: data.title || watch.label || watch.itemCode,
      listingLive: true,
      available: available,
      variationCount: 1,
      buyableNames: available ? [data.addToCartText || data.redText || 'purchasable'] : [],
      isPreOrder: true,
      detail: data.redText || data.addToCartText || (available ? 'purchasable' : 'unavailable'),
      preOrderCloses: data.preOrderCloses,
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        /* already gone */
      }
    }
  }
}

module.exports = { checkPBandai: checkPBandai, itemUrl: itemUrl };
