import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateOrders, parseCsv } from '../lib/validate.js';
import { planUpload, applyUpload, removeIllustrativeOrders } from '../lib/upload.js';
import { evaluateWatch } from '../lib/watch.js';
import upload from '../api/upload.js';

// Everything here is invented for the tests, labelled TEST ONLY, and lives in memory.
const distributorIds = new Set(['DIST001', 'DIST002']);
const ctx = { skuIds: new Set(['SKU001']), distributorIds, existingSalesKeys: new Set(), existingOrderKeys: new Set(['DIST001/2026-06']) };
const csv = (lines) => 'Distributor_ID,Month,Order_Volume\r\n' + lines.join('\r\n') + '\r\n';
const GOOD = csv(['DIST001,2026-06,100', 'DIST001,2026-07,100', 'DIST001,2026-08,100', 'DIST001,2026-09,70', 'DIST002,2026-09,50']);

test('orders file: valid rows are read as whole units', () => {
  const r = validateOrders(parseCsv(GOOD), distributorIds);
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 5);
  assert.deepEqual(r.rows[3], { distributor_id: 'DIST001', month: '2026-09', order_volume: 70 });
});

test('orders file: every kind of bad row is named', () => {
  const bad = (lines, pattern) => {
    const r = validateOrders(parseCsv(csv(lines)), distributorIds);
    assert.ok(r.errors.some((e) => pattern.test(e)), `expected ${pattern}, got ${r.errors.join(' | ')}`);
  };
  bad(['DIST999,2026-09,5'], /unknown Distributor_ID "DIST999"/);
  bad(['DIST001,2026-13,5'], /Month must look like 2026-09/);
  bad(['DIST001,2026-9,5'], /Month must look like 2026-09/);
  bad(['DIST001,Sep 2026,5'], /Month must look like/);
  bad(['DIST001,2026-09,-5'], /whole number of units/);
  bad(['DIST001,2026-09,5.5'], /whole number of units/);
  bad(['DIST001,2026-09,abc'], /whole number of units/);
  bad(['DIST001,2026-09,5', 'DIST001,2026-09,6'], /duplicate DIST001\/2026-09/);
  const missing = validateOrders(parseCsv('Distributor_ID,Month,Volume\nDIST001,2026-09,5\n'), distributorIds);
  assert.match(missing.errors[0], /orders: missing column.*Order_Volume/);
});

test('upload plan: counts new and corrected rows and the month range', () => {
  const p = planUpload({ ordersText: GOOD }, ctx);
  assert.deepEqual(p.errors, []);
  assert.equal(p.summary.orders_rows, 5);
  assert.equal(p.summary.orders_corrected, 1); // DIST001/2026-06 already exists
  assert.equal(p.summary.orders_new, 4);
  assert.equal(p.summary.orders_from, '2026-06');
  assert.equal(p.summary.orders_to, '2026-09');
  assert.equal(p.summary.illustrative, false);
});

test('illustrative label: only with an orders file, and it is carried into the plan', () => {
  const p = planUpload({ ordersText: GOOD, illustrative: true }, ctx);
  assert.equal(p.summary.illustrative, true);
  assert.equal(p.illustrative, true);
  const alone = planUpload({ salesText: 'SKU_ID,Week,Units_Sold\nSKU001,2026-W43,5\n', illustrative: true }, ctx);
  assert.match(alone.errors.join(' '), /illustrative label applies to the distributor orders file only/);
  assert.match(planUpload({}, ctx).errors[0], /at least one file/);
});

test('a bad orders file loads nothing, even next to good files', () => {
  const p = planUpload({ salesText: 'SKU_ID,Week,Units_Sold\nSKU001,2026-W43,5\n', ordersText: csv(['DIST999,2026-09,5']) }, ctx);
  assert.ok(p.errors.length);
  assert.equal(p.sales.length + p.orders.length + p.inventory.length, 0);
});

function fakePool(rowCount = 0) {
  const log = [];
  const run = async (sql, params) => { log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return { rows: [], rowCount }; };
  return { log, query: run, connect: async () => ({ query: run, release() {} }) };
}

test('apply: orders are upserted with their label, a re-upload replaces the label, and the upload is recorded', async () => {
  const pool = fakePool();
  await applyUpload(pool, planUpload({ ordersText: GOOD, illustrative: true }, ctx));
  const ins = pool.log.find((l) => l.sql.startsWith('INSERT INTO distributor_orders_monthly'));
  assert.ok(ins, 'orders are inserted');
  assert.match(ins.sql, /ON CONFLICT \(distributor_id, month\) DO UPDATE SET .*illustrative = EXCLUDED\.illustrative/);
  assert.equal(ins.params.filter((v) => v === true).length, 5); // every row labelled illustrative
  const rec = pool.log.find((l) => l.sql.startsWith('INSERT INTO data_uploads'));
  assert.deepEqual(rec.params, [0, 0, 0, 5, true]);
  assert.ok(!pool.log.some((l) => /DELETE FROM/.test(l.sql)), 'an orders upload never deletes anything');
});

test('apply: unlabelled orders are stored as real; no orders file leaves the orders table alone', async () => {
  const real = fakePool();
  await applyUpload(real, planUpload({ ordersText: GOOD }, ctx));
  assert.equal(real.log.find((l) => l.sql.startsWith('INSERT INTO distributor_orders_monthly')).params.filter((v) => v === true).length, 0);
  const none = fakePool();
  await applyUpload(none, planUpload({ salesText: 'SKU_ID,Week,Units_Sold\nSKU001,2026-W43,5\n' }, ctx));
  assert.ok(!none.log.some((l) => /distributor_orders_monthly/.test(l.sql)));
});

test('removing demo data deletes only rows labelled illustrative', async () => {
  const pool = fakePool(7);
  assert.equal(await removeIllustrativeOrders(pool), 7);
  assert.equal(pool.log[0].sql, 'DELETE FROM distributor_orders_monthly WHERE illustrative');
});

test('end to end in memory: an uploaded orders file drives the watch, and only the right distributor fires', () => {
  const p = planUpload({ ordersText: GOOD, illustrative: true }, ctx);
  const watch = evaluateWatch({
    distributors: [{ distributor_id: 'DIST001', distributor_name: 'TEST ONLY One', region: 'R', active: true }, { distributor_id: 'DIST002', distributor_name: 'TEST ONLY Two', region: 'R', active: true }],
    orders: p.orders, dropPct: 30, baselineMonths: 3, todayMonth: '2026-10',
  });
  assert.deepEqual(watch.fired.map((f) => f.distributor_id), ['DIST001']);          // 70 vs average 100: exactly 30% below
  assert.deepEqual(watch.not_evaluated.map((n) => n.distributor_id), ['DIST002']);  // one month only: never treated as zero
});

function fakeRes() { return { statusCode: 200, headers: {}, body: '', headersSent: false, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b || ''; } }; }
test('removing demo data needs the upload password, and refuses when none is set', async () => {
  const saved = { u: process.env.UPLOAD_PASSWORD, d: process.env.DATABASE_URL };
  try {
    process.env.UPLOAD_PASSWORD = 'up-pw'; delete process.env.DATABASE_URL;
    const res = fakeRes();
    await upload({ method: 'POST', url: '/api/upload', headers: {} , body: { mode: 'remove_illustrative' } }, res);
    assert.equal(res.statusCode, 401);
    delete process.env.UPLOAD_PASSWORD;
    const res2 = fakeRes();
    await upload({ method: 'POST', url: '/api/upload', headers: {}, body: { mode: 'remove_illustrative' } }, res2);
    assert.equal(res2.statusCode, 503);
  } finally {
    if (saved.u === undefined) delete process.env.UPLOAD_PASSWORD; else process.env.UPLOAD_PASSWORD = saved.u;
    if (saved.d !== undefined) process.env.DATABASE_URL = saved.d;
  }
});

test('Deepa page: the demo-data banner and the financial-year quarter form are present', () => {
  const html = readFileSync(new URL('../views/deepa.html', import.meta.url), 'utf8');
  assert.ok(html.includes('Illustrative demo data'));
  assert.ok(html.includes('not Freshroots data'));
  for (const opt of ['Q1 (Apr–Jun)', 'Q2 (Jul–Sep)', 'Q3 (Oct–Dec)', 'Q4 (Jan–Mar, next year)']) assert.ok(html.includes(opt), opt);
  assert.ok(html.includes('financial-year quarters'));
});
