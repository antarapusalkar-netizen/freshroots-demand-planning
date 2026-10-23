import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planUpload, applyUpload } from '../lib/upload.js';
import { validateAll } from '../lib/validate.js';

const read = (f) => readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8');
const SALES = read('weekly_sales_seed_data.csv');
const STOCK = read('current_inventory_seed_data.csv');
const { data } = validateAll({ distributors: read('distributor_seed_data.csv'), skus: read('sku_seed_data.csv'), sales: SALES, inventory: STOCK, calendar: read('calendar_seed_data.csv') });
const skuIds = new Set(data.skus.map((s) => s.sku_id));
const existingSalesKeys = new Set(data.sales.map((r) => `${r.sku_id}/${r.week}`));
const ctx = { skuIds, existingSalesKeys };

test('the seed files as an SAP export: valid, all 240 sales rows are corrections, 15 stock rows', () => {
  const p = planUpload({ salesText: SALES, inventoryText: STOCK }, ctx);
  assert.deepEqual(p.errors, []);
  assert.equal(p.summary.sales_rows, 240);
  assert.equal(p.summary.sales_new, 0);
  assert.equal(p.summary.sales_corrected, 240);
  assert.equal(p.summary.weeks_from, '2026-W27');
  assert.equal(p.summary.weeks_to, '2026-W42');
  assert.equal(p.summary.inventory_rows, 15);
  assert.deepEqual(p.summary.as_of_dates, ['2026-10-19']);
  assert.deepEqual(p.summary.skus_missing_stock, []);
});

test('one file alone is fine; neither is not', () => {
  assert.deepEqual(planUpload({ salesText: SALES, inventoryText: '' }, ctx).errors, []);
  assert.equal(planUpload({ salesText: SALES, inventoryText: '' }, ctx).inventory.length, 0);
  assert.deepEqual(planUpload({ salesText: '', inventoryText: STOCK }, ctx).errors, []);
  assert.match(planUpload({ salesText: '', inventoryText: '' }, ctx).errors[0], /at least one file/);
});

test('a new week is counted as new rows', () => {
  const w43 = 'SKU_ID,Week,Units_Sold\n' + [...skuIds].map((id) => `${id},2026-W43,100`).join('\n') + '\n';
  const p = planUpload({ salesText: w43 }, ctx);
  assert.equal(p.summary.sales_new, 15);
  assert.equal(p.summary.sales_corrected, 0);
  assert.equal(p.summary.weeks_to, '2026-W43');
});

test('a stock file missing some SKUs lists them (they will become exceptions)', () => {
  const lines = STOCK.trim().split('\n');
  const partial = lines.slice(0, 14).join('\n') + '\n';
  const p = planUpload({ inventoryText: partial }, ctx);
  assert.deepEqual(p.errors, []);
  assert.equal(p.summary.inventory_rows, 13);
  assert.equal(p.summary.skus_missing_stock.length, 2);
});

function rejects(files, pattern) {
  const p = planUpload(files, ctx);
  assert.ok(p.errors.some((e) => pattern.test(e)), `expected ${pattern}, got ${p.errors.join(' | ')}`);
  assert.equal(p.sales.length + p.inventory.length, 0, 'nothing may be returned for loading when there are errors');
  assert.equal(p.summary, null);
}
test('bad files are rejected with clear messages and nothing to load', () => {
  rejects({ salesText: SALES.replace('Units_Sold', 'Units') }, /sales: missing column.*Units_Sold/);
  rejects({ salesText: SALES + 'SKU999,2026-W43,5\n' }, /unknown SKU_ID "SKU999"/);
  rejects({ salesText: SALES + 'SKU001,2026-W43,-5\n' }, /Units_Sold must be a whole number/);
  rejects({ salesText: SALES + 'SKU001,2026-W42,5\n' }, /duplicate SKU001\/2026-W42/);
  rejects({ salesText: 'SKU_ID,Week,Units_Sold\n' }, /no data rows/);
  rejects({ inventoryText: STOCK.replace('2026-10-19', '19/10/2026') }, /As_Of_Date must be a real date/);
  rejects({ inventoryText: STOCK.replace('SKU001', 'SKU777') }, /stock row 2|unknown SKU_ID "SKU777"/);
  rejects({ salesText: 'SKU_ID,Week,Units_Sold\n"SKU001,2026-W43,5\n' }, /cannot read CSV/);
});
test('a good sales file with a bad stock file loads nothing', () => {
  rejects({ salesText: SALES, inventoryText: STOCK.replace('900', 'abc') }, /Units_On_Hand must be a whole number/);
});
test('very many errors are capped', () => {
  const bad = 'SKU_ID,Week,Units_Sold\n' + Array.from({ length: 40 }, () => 'SKU999,2026-W43,5').join('\n') + '\n';
  const p = planUpload({ salesText: bad }, ctx);
  assert.equal(p.errors.length, 21);
  assert.match(p.errors[20], /and \d+ more/);
});

function fakePool() {
  const log = [];
  const run = async (sql, params) => { log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return { rows: [] }; };
  return { log, connect: async () => ({ query: run, release() {} }) };
}
test('apply: one transaction; sales upserted; stock replaced; upload recorded', async () => {
  const pool = fakePool();
  await applyUpload(pool, planUpload({ salesText: SALES, inventoryText: STOCK }, ctx));
  const sql = pool.log.map((l) => l.sql);
  assert.equal(sql[0], 'BEGIN');
  assert.equal(sql[sql.length - 1], 'COMMIT');
  assert.ok(sql.some((s) => s.startsWith('INSERT INTO sales_weekly') && s.includes('ON CONFLICT (sku_id, week) DO UPDATE')));
  assert.ok(sql.indexOf('DELETE FROM inventory') > 0);
  assert.ok(sql.some((s) => s.startsWith('INSERT INTO data_uploads')));
  assert.ok(!sql.some((s) => /DELETE FROM sales_weekly/.test(s)), 'sales history is never deleted');
});
test('apply with only a sales file leaves stock alone', async () => {
  const pool = fakePool();
  await applyUpload(pool, planUpload({ salesText: SALES }, ctx));
  assert.ok(!pool.log.some((l) => /inventory/.test(l.sql) && !/data_uploads/.test(l.sql)));
});
test('apply rolls back on a database error', async () => {
  const log = [];
  const pool = { connect: async () => ({ query: async (sql) => { log.push(sql.slice(0, 20)); if (/INSERT INTO sales_weekly/.test(sql)) throw new Error('boom'); return { rows: [] }; }, release() {} }) };
  await assert.rejects(() => applyUpload(pool, planUpload({ salesText: SALES }, ctx)), /boom/);
  assert.ok(log.includes('ROLLBACK'));
  assert.ok(!log.includes('COMMIT'));
});

test('mixed and old-style line endings are read, and a bad row is still caught', () => {
  const mixed = SALES.trimEnd() + '\nSKU999,2026-W43,5\nSKU001,2026-W43,-3\r\nSKU002,2026-W42,7\r';
  const p = planUpload({ salesText: mixed }, ctx);
  assert.ok(p.errors.some((e) => /unknown SKU_ID "SKU999"/.test(e)));
  assert.ok(p.errors.some((e) => /Units_Sold must be a whole number/.test(e)));
  assert.ok(p.errors.some((e) => /duplicate SKU002\/2026-W42/.test(e)));
  assert.deepEqual(planUpload({ salesText: SALES.replace(/\r\n/g, '\r'), inventoryText: STOCK.replace(/\r\n/g, '\n') }, ctx).errors, []);
});
