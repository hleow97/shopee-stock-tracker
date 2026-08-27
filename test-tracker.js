#!/usr/bin/env node
'use strict';

/**
 * Offline tests for the tracker's parsing and decision logic.
 *
 * Runs against saved page fixtures — no network, no notifications, no state
 * files touched. Re-run this after any edit to tracker.js, and especially if
 * restock.log starts showing "product payload not found", which means Shopee
 * changed their page structure.
 *
 *   node test-tracker.js
 */

const fs = require('fs');
const path = require('path');
const { extractPayload, evaluate } = require('./tracker.js');

const FIXTURES = path.join(__dirname, 'fixtures');

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log('  PASS  ' + name);
    passed++;
  } else {
    console.log('  FAIL  ' + name);
    console.log('        expected: ' + e);
    console.log('        actual:   ' + a);
    failed++;
  }
}

function fixture(file) {
  return fs.readFileSync(path.join(FIXTURES, file), 'utf8');
}

// -------------------------------------------------- real page: target item

console.log('Target listing (435791627/55366324866) — expected NOT purchasable');
{
  const payload = extractPayload(fixture('target.html'), '435791627', '55366324866');
  check('payload extracted', payload !== null, true);

  const r = evaluate(payload);
  check('parse ok', r.ok, true);
  check('listing is live', r.listingLive, true);
  check('has one variation', r.variationCount, 1);
  check('NOT available', r.available, false);
  check('no buyable variations', r.buyableNames, []);
  check('is a pre-order', r.isPreOrder, true);
  check(
    'title parsed',
    r.title.indexOf('ONE PIECE DAY') !== -1,
    true
  );

  // The trap this whole tracker is built around.
  const model = payload.item.models[0];
  check('masked stock really does claim 10', model.stock, 10);
  check('...while is_grayout says otherwise', model.is_grayout, true);
}

// ------------------------------------------------- real page: control item

console.log('');
console.log('Control listing (1089081395/25500789702) — expected purchasable');
{
  const payload = extractPayload(fixture('control.html'), '1089081395', '25500789702');
  check('payload extracted', payload !== null, true);

  const r = evaluate(payload);
  check('parse ok', r.ok, true);
  check('IS available', r.available, true);
  check('names the buyable variation', r.buyableNames.length > 0, true);
  check('has many variations', r.variationCount > 1, true);

  // Every variation claims stock 10, but only some are truly buyable.
  const models = payload.item.models;
  const allClaimTen = models.every(function (m) {
    return m.stock === 10;
  });
  const someGrayedOut = models.some(function (m) {
    return m.is_grayout === true;
  });
  check('every variation claims stock:10', allClaimTen, true);
  check('yet some are grayed out', someGrayedOut, true);
  check(
    'buyable count is less than total',
    r.buyableNames.length < models.length,
    true
  );
}

// ------------------------------------------------------- synthetic guards

console.log('');
console.log('Guard rails');
{
  function pageWith(item) {
    return 'junk{{"1/2":' + JSON.stringify({ item: item }) + '}more junk';
  }

  // A delisted listing with a buyable-looking model must never alert.
  const banned = evaluate(
    extractPayload(
      pageWith({
        title: 'Delisted thing',
        item_status: 'banned',
        status: 0,
        models: [{ is_grayout: false, is_clickable: true, stock: 10 }],
      }),
      '1',
      '2'
    )
  );
  check('delisted listing is not available', banned.available, false);
  check('delisted listing flagged not live', banned.listingLive, false);

  // Masked stock alone must not imply availability.
  const masked = evaluate(
    extractPayload(
      pageWith({
        title: 'Sold out thing',
        item_status: 'normal',
        status: 1,
        models: [{ is_grayout: true, is_clickable: false, stock: 10 }],
      }),
      '1',
      '2'
    )
  );
  check('stock:10 + grayout is NOT available', masked.available, false);

  // Genuine availability.
  const live = evaluate(
    extractPayload(
      pageWith({
        title: 'In stock thing',
        item_status: 'normal',
        status: 1,
        models: [
          { name: 'Variant A', is_grayout: true, is_clickable: false },
          { name: 'Variant B', is_grayout: false, is_clickable: true },
        ],
      }),
      '1',
      '2'
    )
  );
  check('one buyable variation is available', live.available, true);
  check('names only the buyable one', live.buyableNames, ['Variant B']);

  // An item with no variations at all must not crash or alert.
  const empty = evaluate(
    extractPayload(
      pageWith({ title: 'No models', item_status: 'normal', status: 1, models: [] }),
      '1',
      '2'
    )
  );
  check('empty model list is not available', empty.available, false);

  // Wrong ids must miss cleanly rather than match something adjacent.
  check(
    'unknown id returns null',
    extractPayload(pageWith({ title: 'x', models: [] }), '9', '9'),
    null
  );

  // Brace matching must survive braces and quotes inside string values.
  const tricky = extractPayload(
    'x{"1/2":' +
      JSON.stringify({
        item: {
          title: 'Weird } name { with "quotes" and }}} braces',
          item_status: 'normal',
          status: 1,
          models: [{ name: 'ok', is_grayout: false, is_clickable: true }],
        },
      }) +
      '}tail',
    '1',
    '2'
  );
  check('braces inside strings do not break matching', tricky !== null, true);
  check(
    'title with braces survives',
    tricky && tricky.item.title.indexOf('}}} braces') !== -1,
    true
  );

  // Malformed payload must return null, not throw.
  check('truncated json returns null', extractPayload('a{"1/2":{"item":', '1', '2'), null);
  check('missing item object handled', evaluate({}).ok, false);
  check('null payload handled', evaluate(null).ok, false);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed > 0 ? 1 : 0;
