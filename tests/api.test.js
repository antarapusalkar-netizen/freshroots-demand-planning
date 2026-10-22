import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, APPROVED_COLUMNS } from '../lib/csv.js';
import { validateDecision } from '../lib/decisions.js';
import { flagRowsFromResults, approvedRows } from '../lib/store.js';

test('csv: quotes, commas, newlines and header row', () => {
  const out = toCsv([{ a: 'x,y', b: 'say "hi"', c: 'l1\nl2', d: 5, e: null }], [
    { header: 'A', key: 'a' }, { header: 'B', key: 'b' }, { header: 'C', key: 'c' }, { header: 'D', key: 'd' }, { header: 'E', key: 'e' },
  ]);
  assert.equal(out, 'A,B,C,D,E\r\n"x,y","say ""hi""","l1\nl2",5,\r\n');
});

test('csv: text starting with = + - @ gets a leading quote so Excel will not run it', () => {
  const out = toCsv([{ a: '=SUM(A1)', b: '+1', c: '-2', d: '@x', e: 'fine' }], ['a', 'b', 'c', 'd', 'e'].map((k) => ({ header: k, key: k })));
  assert.equal(out, "a,b,c,d,e\r\n'=SUM(A1),'+1,'-2,'@x,fine\r\n");
});

test('csv: numbers (including 0) are written as numbers, not prefixed', () => {
  assert.equal(toCsv([{ q: 0 }], [{ header: 'Q', key: 'q' }]), 'Q\r\n0\r\n');
});

const flagged = { is_exception: false, flag_types: ['stockout-risk'] };
const exception = { is_exception: true, flag_types: [] };
const noAction = { is_exception: false, flag_types: [] };

test('decision: approve a flagged line', () => {
  assert.deepEqual(validateDecision({ flag_id: 3, decision: 'approved' }, flagged).value,
    { flag_id: 3, decision: 'approved', override_qty: null, note: null });
});
test('decision: approve ignores any quantity sent with it', () => {
  assert.equal(validateDecision({ flag_id: 3, decision: 'approved', override_qty: 99 }, flagged).value.override_qty, null);
});
test('decision: override with quantity and note', () => {
  assert.deepEqual(validateDecision({ flag_id: 3, decision: 'overridden', override_qty: '120', note: '  call distributor ' }, flagged).value,
    { flag_id: 3, decision: 'overridden', override_qty: 120, note: 'call distributor' });
});
test('decision: override with no quantity is allowed; 0 is a real quantity', () => {
  assert.equal(validateDecision({ flag_id: 3, decision: 'overridden', override_qty: '' }, flagged).value.override_qty, null);
  assert.equal(validateDecision({ flag_id: 3, decision: 'overridden', override_qty: 0 }, flagged).value.override_qty, 0);
});
test('decision: bad quantity, bad decision, long note are rejected', () => {
  assert.match(validateDecision({ flag_id: 3, decision: 'overridden', override_qty: '-4' }, flagged).error, /whole number/);
  assert.match(validateDecision({ flag_id: 3, decision: 'overridden', override_qty: '1.5' }, flagged).error, /whole number/);
  assert.match(validateDecision({ flag_id: 3, decision: 'maybe' }, flagged).error, /approved/);
  assert.match(validateDecision({ flag_id: 3, decision: 'overridden', note: 'x'.repeat(501) }, flagged).error, /too long/);
});
test('decision: exceptions cannot be approved, only overridden', () => {
  assert.match(validateDecision({ flag_id: 4, decision: 'approved' }, exception).error, /Override/);
  assert.ok(validateDecision({ flag_id: 4, decision: 'overridden', override_qty: 50 }, exception).value);
});
test('decision: no-flag SKUs, unknown flags and bad ids are rejected', () => {
  assert.match(validateDecision({ flag_id: 5, decision: 'approved' }, noAction).error, /nothing to decide/);
  assert.match(validateDecision({ flag_id: 5, decision: 'approved' }, null).error, /No such flag/);
  assert.match(validateDecision({ flag_id: 'abc', decision: 'approved' }, flagged).error, /flag_id/);
});

test('save: every SKU result becomes one flags row, in order', () => {
  const results = [
    { sku_id: 'SKU001', flag_types: ['stockout-risk'], recommended_action: 'reorder-now', recommended_qty: 500, rule_reason: 'r1', is_exception: false },
    { sku_id: 'SKU002', flag_types: [], recommended_action: null, recommended_qty: null, rule_reason: 'No action', is_exception: false },
  ];
  const rows = flagRowsFromResults(results);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], results[0]);
  assert.deepEqual(rows[1].flag_types, []);
});

test('approved list: only decided lines; approved uses recommended qty, overridden uses its own', () => {
  const base = { sku_name: 'N', recommended_action: 'reorder-now', note: null, decided_at: new Date('2026-10-22T10:00:00Z') };
  const rows = approvedRows([
    { ...base, sku_id: 'SKU001', flag_types: ['high-demand', 'stockout-risk'], recommended_qty: 750, decision: 'approved', override_qty: null },
    { ...base, sku_id: 'SKU002', flag_types: ['stockout-risk'], recommended_qty: 300, decision: 'overridden', override_qty: 100, note: 'half' },
    { ...base, sku_id: 'SKU003', flag_types: ['stockout-risk'], recommended_qty: 300, decision: 'overridden', override_qty: null },
    { ...base, sku_id: 'SKU004', flag_types: ['stockout-risk'], recommended_qty: 150, decision: null, override_qty: null },
    { ...base, sku_id: 'SKU005', flag_types: ['overstock-risk'], recommended_action: 'pause-order', recommended_qty: 0, decision: 'approved', override_qty: null },
  ], '2026-10-22');
  assert.deepEqual(rows.map((r) => r.sku_id), ['SKU001', 'SKU002', 'SKU003', 'SKU005']);
  assert.equal(rows[0].final_qty, 750);
  assert.equal(rows[0].flags, 'high-demand + stockout-risk');
  assert.equal(rows[1].final_qty, 100);
  assert.equal(rows[2].final_qty, null); // override with no quantity stays blank
  assert.equal(rows[3].final_qty, 0);    // approved pause = 0
  assert.ok(toCsv(rows, APPROVED_COLUMNS).startsWith('Run_Date,SKU_ID,SKU_Name,Flags,'));
});
