import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateDistributorInput, regionCounts } from '../lib/distributors.js';

const ctx = {
  existing: new Map([['DIST001', { active: true }], ['DIST002', { active: true }], ['DIST003', { active: false }]]),
  activeSkusByDistributor: new Map([['DIST001', ['SKU001', 'SKU002']], ['DIST002', []]]),
};
const good = { distributor_id: 'DIST900', distributor_name: 'TEST ONLY Traders', region: 'Test Region', status: 'Active' };
const bad = (body, action, pattern) => {
  const r = validateDistributorInput(body, action, ctx);
  assert.ok(r.errors, `expected errors for ${JSON.stringify(body)}`);
  assert.ok(r.errors.some((e) => pattern.test(e)), `expected ${pattern}, got ${r.errors.join(' | ')}`);
};

test('add: a valid distributor, trimmed; status is kept as typed', () => {
  assert.deepEqual(validateDistributorInput({ ...good, distributor_name: '  TEST ONLY Traders ', status: 'On hold' }, 'add', ctx).value,
    { distributor_id: 'DIST900', distributor_name: 'TEST ONLY Traders', region: 'Test Region', status: 'On hold' });
});
test('add: ID rules and duplicates (ignoring case, inactive ones count)', () => {
  bad({ ...good, distributor_id: 'D 9/0' }, 'add', /letters, digits/);
  bad({ ...good, distributor_id: 'dist001' }, 'add', /already exists/);
  bad({ ...good, distributor_id: 'DIST003' }, 'add', /already exists/);
  bad({ ...good, distributor_id: '' }, 'add', /ID is required/);
});
test('add and edit: name, region and status are required', () => {
  bad({ ...good, distributor_name: '' }, 'add', /Name is required/);
  bad({ ...good, region: ' ' }, 'add', /Region is required/);
  bad({ ...good, status: '' }, 'add', /Status is required/);
  bad({ ...good, distributor_name: 'x'.repeat(121) }, 'add', /too long/);
  bad({ ...good, distributor_id: 'DIST001', region: '' }, 'edit', /Region is required/);
});
test('edit: only an existing distributor, by exact ID', () => {
  assert.equal(validateDistributorInput({ ...good, distributor_id: 'DIST001' }, 'edit', ctx).value.distributor_id, 'DIST001');
  bad({ ...good, distributor_id: 'DIST777' }, 'edit', /No such distributor/);
});
test('A9: a distributor with active SKUs cannot be deactivated, and the SKUs are named', () => {
  bad({ distributor_id: 'DIST001' }, 'deactivate', /2 active SKUs \(SKU001, SKU002\)/);
  bad({ distributor_id: 'DIST001' }, 'deactivate', /Reassign them/);
  assert.deepEqual(validateDistributorInput({ distributor_id: 'DIST002' }, 'deactivate', ctx).value, { distributor_id: 'DIST002', active: false });
});
test('A9: long SKU lists are shortened; reactivate and state checks', () => {
  const many = { existing: new Map([['D', { active: true }]]), activeSkusByDistributor: new Map([['D', Array.from({ length: 14 }, (_, i) => `S${i}`)]]) };
  const r = validateDistributorInput({ distributor_id: 'D' }, 'deactivate', many);
  assert.match(r.errors[0], /14 active SKUs/);
  assert.match(r.errors[0], /and 4 more/);
  assert.deepEqual(validateDistributorInput({ distributor_id: 'DIST003' }, 'reactivate', ctx).value, { distributor_id: 'DIST003', active: true });
  bad({ distributor_id: 'DIST003' }, 'deactivate', /already inactive/);
  bad({ distributor_id: 'DIST002' }, 'reactivate', /already active/);
  bad({ distributor_id: 'DIST777' }, 'deactivate', /No such distributor/);
  bad({ distributor_id: 'DIST002' }, 'delete', /Unknown action/);
});
test('region counts, sorted by region name', () => {
  const r = regionCounts([{ region: 'Karnataka', active: true }, { region: 'Gujarat', active: true }, { region: 'Karnataka', active: false }, { region: 'Gujarat', active: false }, { region: 'Gujarat', active: true }]);
  assert.deepEqual(r, [{ region: 'Gujarat', total: 3, active: 2 }, { region: 'Karnataka', total: 2, active: 1 }]);
});
test('nothing in the distributor or Deepa code can delete a distributor', () => {
  for (const f of ['../lib/distributors.js', '../api/distributors.js', '../api/deepa.js', '../lib/watch.js']) {
    assert.ok(!/DELETE\s+FROM/i.test(readFileSync(new URL(f, import.meta.url), 'utf8')), `${f} must not delete rows`);
  }
});
