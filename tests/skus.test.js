import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSkuInput } from '../lib/skus.js';
import { loadInputs } from '../lib/store.js';
import { evaluateAll } from '../lib/rules.js';
import { planUpload } from '../lib/upload.js';
import { validateAll } from '../lib/validate.js';
import { settingsFromRows } from '../lib/settings.js';

const ctx = {
  distributorIds: new Set(['DIST001', 'DIST002']),
  existing: new Map([['SKU001', { active: true, distributor_id: 'DIST001' }], ['SKU002', { active: false, distributor_id: 'DIST001' }], ['SKU003', { active: false, distributor_id: 'DIST009' }]]),
};
const good = { sku_id: 'SKU900', sku_name: 'Test Juice 1L', category: 'Beverage', perishable: true, standard_reorder_qty: '200', unit_of_measure: 'Units', distributor_id: 'DIST001' };
const bad = (body, action, pattern) => {
  const r = validateSkuInput(body, action, ctx);
  assert.ok(r.errors, `expected errors for ${JSON.stringify(body)}`);
  assert.ok(r.errors.some((e) => pattern.test(e)), `expected ${pattern}, got ${r.errors.join(' | ')}`);
};

test('add: a valid SKU, trimmed, perishable becomes High', () => {
  const r = validateSkuInput({ ...good, sku_id: '  SKU900 ', sku_name: ' Test Juice 1L ' }, 'add', ctx);
  assert.deepEqual(r.value, { sku_id: 'SKU900', sku_name: 'Test Juice 1L', category: 'Beverage', perishability: 'High', standard_reorder_qty: 200, unit_of_measure: 'Units', distributor_id: 'DIST001' });
  assert.equal(validateSkuInput({ ...good, perishable: false }, 'add', ctx).value.perishability, 'Low');
  assert.equal(validateSkuInput({ ...good, perishable: 'false' }, 'add', ctx).value.perishability, 'Low');
});

test('add: ID rules and duplicates (also ignoring case, and inactive SKUs still count)', () => {
  bad({ ...good, sku_id: 'SKU 9/00' }, 'add', /letters, digits/);
  bad({ ...good, sku_id: 'X'.repeat(33) }, 'add', /32 characters/);
  bad({ ...good, sku_id: 'sku001' }, 'add', /already exists/);
  bad({ ...good, sku_id: 'SKU002' }, 'add', /already exists/);
  bad({ ...good, sku_id: '' }, 'add', /SKU ID is required/);
});

test('add and edit: every field is checked', () => {
  bad({ ...good, sku_name: '' }, 'add', /Name is required/);
  bad({ ...good, category: '   ' }, 'add', /Category is required/);
  bad({ ...good, unit_of_measure: '' }, 'add', /Unit is required/);
  bad({ ...good, sku_name: 'x'.repeat(121) }, 'add', /Name is too long/);
  for (const q of ['0', '-5', '1.5', 'abc', '', undefined]) bad({ ...good, standard_reorder_qty: q }, 'add', /whole number above 0/);
  bad({ ...good, perishable: 'maybe' }, 'add', /Perishable must be yes or no/);
  bad({ ...good, perishable: undefined }, 'add', /Perishable must be yes or no/);
  bad({ ...good, distributor_id: 'DIST999' }, 'add', /active distributor/);
  bad({ ...good, distributor_id: '' }, 'add', /active distributor/);
  bad({ ...good, sku_id: 'SKU001', standard_reorder_qty: '0' }, 'edit', /whole number above 0/);
});

test('edit: only an existing SKU; the ID itself is not changed', () => {
  const r = validateSkuInput({ ...good, sku_id: 'SKU001', standard_reorder_qty: 250 }, 'edit', ctx);
  assert.equal(r.value.sku_id, 'SKU001');
  assert.equal(r.value.standard_reorder_qty, 250);
  bad({ ...good, sku_id: 'SKU777' }, 'edit', /No such SKU/);
  bad({ ...good, sku_id: 'sku001' }, 'edit', /No such SKU/); // exact ID only
});

test('deactivate and reactivate: state checked, nothing else needed', () => {
  assert.deepEqual(validateSkuInput({ sku_id: 'SKU001' }, 'deactivate', ctx).value, { sku_id: 'SKU001', active: false });
  assert.deepEqual(validateSkuInput({ sku_id: 'SKU002' }, 'reactivate', ctx).value, { sku_id: 'SKU002', active: true });
  bad({ sku_id: 'SKU002' }, 'deactivate', /already inactive/);
  bad({ sku_id: 'SKU003' }, 'reactivate', /distributor is inactive/); // A9: its distributor is not active
  bad({ sku_id: 'SKU001' }, 'reactivate', /already active/);
  bad({ sku_id: 'SKU777' }, 'deactivate', /No such SKU/);
  bad({ sku_id: 'SKU001' }, 'delete', /Unknown action/);
  assert.deepEqual(validateSkuInput(null, 'add', ctx).errors, ['Missing request body.']);
});

test('nothing in the SKU code can delete a SKU', () => {
  for (const f of ['../lib/skus.js', '../api/skus.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/DELETE\s+FROM/i.test(src), `${f} must not delete rows`);
  }
});

// ---- A8 and A9 ----
test('runs read only active SKUs', async () => {
  const sqls = [];
  const pool = { query: async (sql) => { sqls.push(sql); return { rows: [] }; } };
  await loadInputs(pool);
  const skuQuery = sqls.find((s) => /FROM skus/.test(s));
  assert.match(skuQuery, /WHERE active/);
});

const S = settingsFromRows(Object.entries({ recent_weeks: 4, average_weeks: 12, high_demand_pct: 20, high_demand_multiplier: 1.5, stockout_weeks: 6, overstock_weeks: 14, festival_uplift_pct: 25, perishable_min_weeks: 3, perishable_max_weeks: 4 }).map(([key, value]) => ({ key, value })));
const calendar = [{ year: 2026, month: 10, is_festival_month: true }];
const newSku = { sku_id: 'SKU900', sku_name: 'New', perishability: 'Low', standard_reorder_qty: 100 };
const weeks = (n) => Array.from({ length: n }, (_, i) => ({ sku_id: 'SKU900', week: `2026-W${String(10 + i).padStart(2, '0')}`, units_sold: 100 }));

test('A8: a new SKU with no stock and no sales goes to exceptions, with no flag', () => {
  const r = evaluateAll({ skus: [newSku], inventory: [], sales: [], calendar }, S);
  assert.equal(r.results[0].is_exception, true);
  assert.deepEqual(r.results[0].flag_types, []);
  assert.equal(r.results[0].recommended_action, null);
});
test('A8: with stock but fewer than 12 weeks of sales it stays in exceptions, naming the weeks', () => {
  const inv = [{ sku_id: 'SKU900', units_on_hand: 100, as_of_date: '2026-10-19' }];
  const r = evaluateAll({ skus: [newSku], inventory: inv, sales: weeks(11), calendar }, S);
  assert.equal(r.results[0].is_exception, true);
  assert.match(r.results[0].rule_reason, /Only 11 weeks/);
});
test('A8: at 12 weeks the normal rules apply', () => {
  const inv = [{ sku_id: 'SKU900', units_on_hand: 100, as_of_date: '2026-10-19' }];
  const r = evaluateAll({ skus: [newSku], inventory: inv, sales: weeks(12), calendar }, S);
  assert.equal(r.results[0].is_exception, false);
});

test('upload: the "no stock row" warning ignores inactive SKUs', () => {
  const read = (f) => readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8');
  const { data } = validateAll({ distributors: read('distributor_seed_data.csv'), skus: read('sku_seed_data.csv'), sales: read('weekly_sales_seed_data.csv'), inventory: read('current_inventory_seed_data.csv'), calendar: read('calendar_seed_data.csv') });
  const skuIds = new Set([...data.skus.map((s) => s.sku_id), 'SKU900']);
  const activeSkuIds = new Set(data.skus.map((s) => s.sku_id)); // SKU900 inactive
  const stock = read('current_inventory_seed_data.csv');
  const withInactive = planUpload({ inventoryText: stock }, { skuIds, activeSkuIds, existingSalesKeys: new Set() });
  assert.deepEqual(withInactive.summary.skus_missing_stock, []);
  const allActive = planUpload({ inventoryText: stock }, { skuIds, activeSkuIds: skuIds, existingSalesKeys: new Set() });
  assert.deepEqual(allActive.summary.skus_missing_stock, ['SKU900']);
  // stock rows for an inactive SKU are still accepted (history is kept)
  const withRow = stock.trimEnd() + '\nSKU900,Pune Central Warehouse,10,2026-10-19\n';
  assert.deepEqual(planUpload({ inventoryText: withRow }, { skuIds, activeSkuIds, existingSalesKeys: new Set() }).errors, []);
});
