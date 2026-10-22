import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateAll } from '../lib/validate.js';
import { settingsFromRows } from '../lib/settings.js';
import {
  averageWeekly, applyFestivalUplift, weeksOfStock, checkHighDemand, checkStockout, checkOverstock,
  checkExceptions, hasConflict, recommend, evaluateSku, evaluateAll, isFestivalMonth, FLAG, ACTION,
} from '../lib/rules.js';

const S = settingsFromRows([
  ['recent_weeks', 4], ['average_weeks', 12], ['high_demand_pct', 20], ['high_demand_multiplier', 1.5],
  ['stockout_weeks', 6], ['overstock_weeks', 14], ['festival_uplift_pct', 25],
  ['perishable_min_weeks', 3], ['perishable_max_weeks', 4],
].map(([key, value]) => ({ key, value })));

const read = (f) => readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8');
const { data } = validateAll({
  distributors: read('distributor_seed_data.csv'),
  skus: read('sku_seed_data.csv'),
  sales: read('weekly_sales_seed_data.csv'),
  inventory: read('current_inventory_seed_data.csv'),
  calendar: read('calendar_seed_data.csv'),
});

// ---- Section 8 of CLAUDE.md: the sample data, festival month = October ----
test('section 8 table: flags per SKU on the sample data', () => {
  const { asOfDate, festival, results } = evaluateAll(data, S);
  assert.equal(asOfDate, '2026-10-19');
  assert.equal(festival, true);
  const by = Object.fromEntries(results.map((r) => [r.sku_id, r]));
  const flags = (id) => by[id].flag_types.join('+');

  assert.equal(flags('SKU001'), 'high-demand+stockout-risk');
  assert.equal(by.SKU001.recommended_action, ACTION.REORDER_NOW);
  assert.equal(by.SKU001.recommended_qty, 750); // 1.5 x 500
  for (const id of ['SKU003', 'SKU013', 'SKU004', 'SKU011']) {
    assert.equal(flags(id), 'stockout-risk', id);
    assert.equal(by[id].recommended_action, ACTION.REORDER_NOW, id);
  }
  for (const id of ['SKU006', 'SKU007']) {
    assert.equal(flags(id), 'overstock-risk', id);
    assert.equal(by[id].recommended_action, ACTION.PAUSE_ORDER, id);
    assert.equal(by[id].recommended_qty, 0, id);
  }
  for (const id of ['SKU002', 'SKU005', 'SKU008', 'SKU009', 'SKU010', 'SKU012', 'SKU014', 'SKU015']) {
    assert.deepEqual(by[id].flag_types, [], id);
    assert.equal(by[id].recommended_action, null, id);
  }
  assert.equal(results.filter((r) => r.is_exception).length, 0);
  assert.equal(results.length, 15);
});

test('results are sorted by SKU ID', () => {
  const ids = evaluateAll(data, S).results.map((r) => r.sku_id);
  assert.deepEqual(ids, [...ids].sort());
});

test('stock-cover numbers in the reasons match section 8', () => {
  const by = Object.fromEntries(evaluateAll(data, S).results.map((r) => [r.sku_id, r]));
  assert.match(by.SKU001.rule_reason, /3\.4 weeks/);
  assert.match(by.SKU004.rule_reason, /1\.8 weeks/);
  assert.match(by.SKU006.rule_reason, /22\.2 weeks/);
  assert.match(by.SKU007.rule_reason, /4\.1 weeks/);
});

test('same data outside a festival month gives different results (uplift matters)', () => {
  const noFest = data.calendar.map((c) => (c.month === 10 ? { ...c, is_festival_month: false } : c));
  const { festival, results } = evaluateAll({ ...data, calendar: noFest }, S);
  assert.equal(festival, false);
  const by = Object.fromEntries(results.map((r) => [r.sku_id, r]));
  // The uplift raises demand, so it lowers weeks of stock. Without it, stock lasts longer:
  // SKU002 goes from 11.5 weeks (no flag) to 14.3 weeks (overstock).
  assert.deepEqual(by.SKU002.flag_types, ['overstock-risk']);
  assert.match(by.SKU002.rule_reason, /14\.3 weeks/);
  // SKU001 stays high-demand + stockout (4.2 weeks, still below 6)
  assert.deepEqual(by.SKU001.flag_types, ['high-demand', 'stockout-risk']);
  // SKU007 (perishable) is 5.1 weeks, still above 4
  assert.deepEqual(by.SKU007.flag_types, ['overstock-risk']);
});

// ---- Individual rule functions ----
test('averageWeekly uses the last N weeks and needs N weeks', () => {
  assert.equal(averageWeekly([1, 2, 3, 4], 2), 3.5);
  assert.equal(averageWeekly([1, 2, 3], 4), null);
});

test('rule 4: uplift only in festival months', () => {
  assert.equal(applyFestivalUplift(100, true, 25), 125);
  assert.equal(applyFestivalUplift(100, false, 25), 100);
});

test('rule 1: high demand is strictly more than 20% above', () => {
  assert.equal(checkHighDemand(120, 100, 20), false); // exactly 20%
  assert.equal(checkHighDemand(121, 100, 20), true);
  assert.equal(checkHighDemand(100, 100, 20), false);
});

test('rule 2: stockout is strictly below 6 weeks (3 if perishable)', () => {
  assert.equal(checkStockout(weeksOfStock(600, 100), false, S), false); // exactly 6
  assert.equal(checkStockout(weeksOfStock(599, 100), false, S), true);
  assert.equal(checkStockout(5, true, S), false); // 5 weeks is fine for perishable
  assert.equal(checkStockout(2.9, true, S), true);
  assert.equal(checkStockout(3, true, S), false);
});

test('rule 3: overstock is strictly above 14 weeks (4 if perishable)', () => {
  assert.equal(checkOverstock(weeksOfStock(1400, 100), false, S), false); // exactly 14
  assert.equal(checkOverstock(14.1, false, S), true);
  assert.equal(checkOverstock(4, true, S), false);
  assert.equal(checkOverstock(4.1, true, S), true);
  assert.equal(checkOverstock(10, true, S), true); // perishable window replaces the 14-week one
});

test('recommend: quantities follow A5', () => {
  assert.deepEqual(recommend([FLAG.STOCKOUT], 300, S), { action: ACTION.REORDER_NOW, qty: 300 });
  assert.deepEqual(recommend([FLAG.HIGH_DEMAND], 300, S), { action: ACTION.REORDER_NOW, qty: 450 });
  assert.deepEqual(recommend([FLAG.HIGH_DEMAND, FLAG.STOCKOUT], 300, S), { action: ACTION.REORDER_NOW, qty: 450 });
  assert.deepEqual(recommend([FLAG.OVERSTOCK], 300, S), { action: ACTION.PAUSE_ORDER, qty: 0 });
  assert.deepEqual(recommend([], 300, S), { action: null, qty: null });
});

test('hasConflict: overstock with stockout or high-demand only', () => {
  assert.equal(hasConflict([FLAG.OVERSTOCK, FLAG.STOCKOUT]), true);
  assert.equal(hasConflict([FLAG.OVERSTOCK, FLAG.HIGH_DEMAND]), true);
  assert.equal(hasConflict([FLAG.HIGH_DEMAND, FLAG.STOCKOUT]), false);
  assert.equal(hasConflict([FLAG.OVERSTOCK]), false);
});

test('isFestivalMonth looks up the as-of month; unknown month gives null', () => {
  assert.equal(isFestivalMonth('2026-10-19', data.calendar), true);
  assert.equal(isFestivalMonth('2026-09-30', data.calendar), false);
  assert.equal(isFestivalMonth('2031-01-01', data.calendar), null);
});

// ---- Exceptions ----
const sku = { sku_id: 'SKU900', perishability: 'Low', standard_reorder_qty: 100 };
const weeks = (n, v = 100) => Array(n).fill(v);

test('exception: fewer than 12 weeks of history', () => {
  const r = evaluateSku({ sku, stock: { units_on_hand: 500 }, units: weeks(11), festival: false }, S);
  assert.equal(r.is_exception, true);
  assert.match(r.rule_reason, /Only 11 weeks/);
  assert.equal(r.recommended_action, null);
});

test('exception: average of zero', () => {
  const r = evaluateSku({ sku, stock: { units_on_hand: 500 }, units: weeks(12, 0), festival: false }, S);
  assert.equal(r.is_exception, true);
  assert.match(r.rule_reason, /zero/);
});

test('exception: missing stock, missing SKU, unknown festival status', () => {
  assert.match(evaluateSku({ sku, stock: undefined, units: weeks(12), festival: false }, S).rule_reason, /Missing stock/);
  assert.match(evaluateSku({ sku: undefined, stock: { units_on_hand: 5 }, units: weeks(12), festival: false }, S).rule_reason, /Missing SKU/);
  assert.match(evaluateSku({ sku, stock: { units_on_hand: 5 }, units: weeks(12), festival: null }, S).rule_reason, /Festival status unknown/);
});

test('exception: conflicting flags keep the flags but give no recommendation', () => {
  // High recent demand (last 4 weeks double) with huge stock: high-demand + overstock
  const units = [...weeks(8, 100), ...weeks(4, 300)];
  const r = evaluateSku({ sku, stock: { units_on_hand: 100000 }, units, festival: false }, S);
  assert.equal(r.is_exception, true);
  assert.deepEqual(r.flag_types, [FLAG.HIGH_DEMAND, FLAG.OVERSTOCK]);
  assert.equal(r.recommended_action, null);
  assert.equal(r.recommended_qty, null);
  assert.match(r.rule_reason, /Conflicting flags/);
});

test('checkExceptions returns null for a normal SKU', () => {
  assert.equal(checkExceptions({ sku, stock: { units_on_hand: 5 }, units: weeks(12), festival: false }, S), null);
});

test('settingsFromRows rejects a missing setting instead of guessing', () => {
  assert.throws(() => settingsFromRows([{ key: 'recent_weeks', value: '4' }]), /missing/);
});
