import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateAll } from '../lib/validate.js';

const read = (f) => readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8');
const real = () => ({
  distributors: read('distributor_seed_data.csv'),
  skus: read('sku_seed_data.csv'),
  sales: read('weekly_sales_seed_data.csv'),
  inventory: read('current_inventory_seed_data.csv'),
  calendar: read('calendar_seed_data.csv'),
});

test('real sample files pass with the expected row counts', () => {
  const { data, errors } = validateAll(real());
  assert.deepEqual(errors, []);
  assert.equal(data.skus.length, 15);
  assert.equal(data.sales.length, 240);
  assert.equal(data.inventory.length, 15);
  assert.equal(data.calendar.length, 24);
  assert.equal(data.distributors.length, 4);
});

test('festival months are Mar, Oct, Nov', () => {
  const { data } = validateAll(real());
  const months = [...new Set(data.calendar.filter((c) => c.is_festival_month).map((c) => c.month))].sort((a, b) => a - b);
  assert.deepEqual(months, [3, 10, 11]);
});

test('perishable SKUs are SKU004, SKU007, SKU011', () => {
  const { data } = validateAll(real());
  assert.deepEqual(data.skus.filter((s) => s.perishability === 'High').map((s) => s.sku_id), ['SKU004', 'SKU007', 'SKU011']);
});

function expectError(mutate, pattern) {
  const t = real();
  mutate(t);
  const { errors } = validateAll(t);
  assert.ok(errors.some((e) => pattern.test(e)), `expected error matching ${pattern}, got: ${errors.join(' | ')}`);
}

test('missing column is rejected', () => {
  expectError((t) => { t.sales = t.sales.replace('Units_Sold', 'Units'); }, /sales: missing column.*Units_Sold/);
});
test('unknown SKU in sales is rejected', () => {
  expectError((t) => { t.sales += 'SKU999,2026-W27,10\n'; }, /unknown SKU_ID "SKU999"/);
});
test('unknown distributor on a SKU is rejected', () => {
  expectError((t) => { t.skus = t.skus.replace('DIST001', 'DIST999'); }, /unknown Distributor_ID/);
});
test('bad perishability is rejected', () => {
  expectError((t) => { t.skus = t.skus.replace(',High,', ',Medium,'); }, /Perishability must be High or Low/);
});
test('negative or non-numeric units are rejected', () => {
  expectError((t) => { t.sales += 'SKU001,2026-W50,-5\n'; }, /Units_Sold must be a whole number/);
  expectError((t) => { t.inventory = t.inventory.replace('900', 'abc'); }, /Units_On_Hand must be a whole number/);
});
test('bad week format is rejected', () => {
  expectError((t) => { t.sales += 'SKU001,2026-27,5\n'; }, /Week must look like/);
});
test('duplicate sales row is rejected', () => {
  expectError((t) => { t.sales += 'SKU001,2026-W27,194\n'; }, /duplicate SKU001\/2026-W27/);
});
test('duplicate SKU is rejected', () => {
  expectError((t) => { t.skus += 'SKU001,Dup,Snack,Low,10,Units,DIST001\n'; }, /skus: duplicate SKU001/);
});
test('impossible date is rejected', () => {
  expectError((t) => { t.inventory = t.inventory.replace('2026-10-19', '2026-02-31'); }, /As_Of_Date must be a real date/);
});
test('bad festival flag and mismatched Year_Month are rejected', () => {
  expectError((t) => { t.calendar = t.calendar.replace('2025,1,2025-01,FALSE', '2025,1,2025-01,MAYBE'); }, /Is_Festival_Month must be TRUE or FALSE/);
  expectError((t) => { t.calendar = t.calendar.replace('2025-02', '2025-07'); }, /does not match Year\/Month/);
});
