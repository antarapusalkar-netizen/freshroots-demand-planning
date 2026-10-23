import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWatch, addMonths, currentMonthIST } from '../lib/watch.js';

// Every row below is invented for these tests and lives only in memory. None of it is ever
// written to the database or shown on a real screen.
const dist = (id, name, extra = {}) => ({ distributor_id: id, distributor_name: `TEST ONLY ${name}`, region: 'Test Region', active: true, ...extra });
const rows = (id, volumes, startMonth = '2026-06') => volumes.map((v, i) => ({ distributor_id: id, month: addMonths(startMonth, i), order_volume: v }));
const watch = (distributors, orders, extra = {}) => evaluateWatch({ distributors, orders, dropPct: 30, baselineMonths: 3, todayMonth: '2026-10', ...extra });
// months 2026-06, 07, 08 = previous three; 2026-09 = latest full month; 2026-10 = month in progress

test('no orders loaded: the state is no_data and nothing else is reported', () => {
  const r = watch([dist('T1', 'A')], []);
  assert.deepEqual(r, { state: 'no_data' });
});

test('30% rule fires exactly at 30% below, not before', () => {
  const at = (latest) => watch([dist('T1', 'A')], rows('T1', [100, 100, 100, latest]));
  assert.equal(at(70).fired.length, 1);   // exactly 30% below: fires ("30% or more")
  assert.equal(at(69).fired.length, 1);   // more than 30% below
  assert.equal(at(71).fired.length, 0);   // 29% below: does not fire
  assert.equal(at(100).fired.length, 0);  // no change
  assert.equal(at(150).fired.length, 0);  // growth never fires
  assert.equal(at(0).fired.length, 1);    // a real zero (a row saying 0) is a 100% drop
});

test('the reported numbers are the real ones, with no score', () => {
  const r = watch([dist('T1', 'A')], rows('T1', [90, 100, 110, 60]));
  const f = r.fired[0];
  assert.equal(r.latest_month, '2026-09');
  assert.equal(f.latest_month, '2026-09');
  assert.equal(f.latest_volume, 60);
  assert.equal(f.previous_average, 100);
  assert.equal(Math.round(f.change_pct * 10) / 10, -40);
  assert.deepEqual(Object.keys(f).sort(), ['change_pct', 'distributor_id', 'distributor_name', 'latest_month', 'latest_volume', 'previous_average', 'region']);
});

test('the average uses the 3 months BEFORE the latest, not the latest itself', () => {
  // previous: 100, 100, 400 => average 200; latest 140 is 30% below 200 => fires. Including latest would not.
  assert.equal(watch([dist('T1', 'A')], rows('T1', [100, 100, 400, 140])).fired.length, 1);
  // older months beyond the 3 are ignored: a huge month 4 back must not change the answer
  const withOld = [...rows('T1', [9999], '2026-05'), ...rows('T1', [100, 100, 100, 71])];
  assert.equal(watch([dist('T1', 'A')], withOld).fired.length, 0);
});

test('the month in progress is never used: a part-month cannot look like a drop', () => {
  const orders = [...rows('T1', [100, 100, 100, 100]), { distributor_id: 'T1', month: '2026-10', order_volume: 5 }];
  const r = watch([dist('T1', 'A')], orders, { todayMonth: '2026-10' });
  assert.equal(r.latest_month, '2026-09');
  assert.equal(r.fired.length, 0);
  // once October is over it becomes the latest full month and the drop is seen
  assert.equal(watch([dist('T1', 'A')], [...orders, { distributor_id: 'T1', month: '2026-10', order_volume: 5 }].filter((o, i, a) => a.indexOf(o) === i), { todayMonth: '2026-11' }).fired.length, 1);
});

test('only the month in progress loaded: no full month yet', () => {
  assert.deepEqual(watch([dist('T1', 'A')], [{ distributor_id: 'T1', month: '2026-10', order_volume: 50 }]), { state: 'no_full_month' });
});

test('a missing month is NOT treated as zero: the distributor is listed as not evaluated', () => {
  const noLatest = watch([dist('T1', 'A')], [...rows('T1', [100, 100, 100]), ...rows('T2', [100, 100, 100, 100])].concat([]), { });
  // T1 has no 2026-09 row, T2 does; latest month is 2026-09 because T2 has it
  const r = watch([dist('T1', 'A'), dist('T2', 'B')], [...rows('T1', [100, 100, 100]), ...rows('T2', [100, 100, 100, 100])]);
  assert.equal(r.fired.length, 0);
  assert.equal(r.not_evaluated.length, 1);
  assert.equal(r.not_evaluated[0].distributor_id, 'T1');
  assert.match(r.not_evaluated[0].reason, /needs orders for 2026-09/);
  assert.equal(noLatest.state, 'ok');
  // a gap in the previous months is also not evaluated
  const gap = watch([dist('T1', 'A')], [{ distributor_id: 'T1', month: '2026-06', order_volume: 100 }, { distributor_id: 'T1', month: '2026-08', order_volume: 100 }, { distributor_id: 'T1', month: '2026-09', order_volume: 10 }]);
  assert.equal(gap.fired.length, 0);
  assert.equal(gap.not_evaluated.length, 1);
});

test('no earlier orders to compare with is not evaluated, and never fires', () => {
  const r = watch([dist('T1', 'A')], rows('T1', [0, 0, 0, 0]));
  assert.equal(r.fired.length, 0);
  assert.match(r.not_evaluated[0].reason, /nothing to compare with/);
});

test('inactive distributors are skipped, and results are sorted by name', () => {
  const ds = [dist('T3', 'Zeta'), dist('T1', 'Alpha'), dist('T2', 'Mid', { active: false }), dist('T4', 'Beta')];
  const orders = ['T1', 'T2', 'T3', 'T4'].flatMap((id) => rows(id, [100, 100, 100, 10]));
  const r = watch(ds, orders);
  assert.deepEqual(r.fired.map((f) => f.distributor_id), ['T1', 'T4', 'T3']); // Alpha, Beta, Zeta
  assert.ok(!r.fired.some((f) => f.distributor_id === 'T2'));
});

test('a drop is reported only for the distributor that dropped', () => {
  const orders = [...rows('T1', [100, 100, 100, 50]), ...rows('T2', [100, 100, 100, 95]), ...rows('T3', [100, 100, 100, 130])];
  const r = watch([dist('T1', 'A'), dist('T2', 'B'), dist('T3', 'C')], orders);
  assert.deepEqual(r.fired.map((f) => f.distributor_id), ['T1']);
});

test('the threshold and number of months are settings, not fixed', () => {
  const orders = rows('T1', [100, 100, 100, 55]);
  assert.equal(watch([dist('T1', 'A')], orders, { dropPct: 30 }).fired.length, 1);
  assert.equal(watch([dist('T1', 'A')], orders, { dropPct: 50 }).fired.length, 0); // 45% below: not enough at 50
  // previous months 200, 100, 100 and a latest month of 80:
  const many = [...rows('T1', [200, 100, 100, 80])];
  assert.equal(watch([dist('T1', 'A')], many, { baselineMonths: 2 }).fired.length, 0); // 2-month average 100: 80 is only 20% below
  assert.equal(watch([dist('T1', 'A')], many, { baselineMonths: 3 }).fired.length, 1); // 3-month average 133.3: 80 is 40% below
});

test('works across a year boundary and with numeric values that arrive as strings', () => {
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2025-11', 3), '2026-02');
  assert.equal(addMonths('2026-12', 1), '2027-01');
  const orders = [{ distributor_id: 'T1', month: '2025-10', order_volume: '100.00' }, { distributor_id: 'T1', month: '2025-11', order_volume: '100' }, { distributor_id: 'T1', month: '2025-12', order_volume: '100' }, { distributor_id: 'T1', month: '2026-01', order_volume: '60.5' }];
  const r = watch([dist('T1', 'A')], orders, { todayMonth: '2026-03' });
  assert.equal(r.latest_month, '2026-01');
  assert.equal(r.fired.length, 1);
});

test('currentMonthIST follows India time, not UTC', () => {
  assert.equal(currentMonthIST(new Date('2026-10-31T18:00:00Z')), '2026-10'); // 23:30 IST on 31 Oct
  assert.equal(currentMonthIST(new Date('2026-10-31T19:00:00Z')), '2026-11'); // 00:30 IST on 1 Nov
});
