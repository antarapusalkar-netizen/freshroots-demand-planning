import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runOverview } from '../lib/deepa.js';
import { validateQuarter, saveQuarter, listQuarters, quarterRange } from '../lib/quarterly.js';
import page from '../api/page.js';

function fakeRes() {
  return { statusCode: 200, headers: {}, body: '', headersSent: false, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b || ''; } };
}

test('quarterly: valid entries, commas and the rupee sign are accepted', () => {
  assert.deepEqual(validateQuarter({ quarter: '2026-q3', lost_sales_inr: '₹20,00,000', writeoffs_inr: '1100000.50' }).value,
    { quarter: '2026-Q3', lost_sales_inr: 2000000, writeoffs_inr: 1100000.5 });
  assert.equal(validateQuarter({ quarter: '2026-Q1', lost_sales_inr: 0, writeoffs_inr: 0 }).value.lost_sales_inr, 0);
});
test('quarterly: bad quarter or amounts are rejected with clear messages', () => {
  const err = (b) => validateQuarter(b).errors.join(' | ');
  assert.match(err({ quarter: '2026-Q5', lost_sales_inr: 1, writeoffs_inr: 1 }), /Quarter must look like 2026-Q3/);
  assert.match(err({ quarter: 'Q3 2026', lost_sales_inr: 1, writeoffs_inr: 1 }), /Quarter must look like/);
  assert.match(err({ quarter: '1999-Q1', lost_sales_inr: 1, writeoffs_inr: 1 }), /Quarter must look like/);
  assert.match(err({ quarter: '2026-Q3', lost_sales_inr: '-5', writeoffs_inr: 1 }), /Lost sales must be a number/);
  assert.match(err({ quarter: '2026-Q3', lost_sales_inr: 1, writeoffs_inr: 'abc' }), /Write-offs must be a number/);
  assert.match(err({ quarter: '2026-Q3', lost_sales_inr: '1.234', writeoffs_inr: 1 }), /2 decimals/);
  assert.match(err({ quarter: '2026-Q3', lost_sales_inr: '', writeoffs_inr: 1 }), /Lost sales must be a number/);
  assert.match(err({ quarter: '2026-Q3', lost_sales_inr: 1e12, writeoffs_inr: 1 }), /too large/);
  assert.deepEqual(validateQuarter(null).errors, ['Missing request body.']);
});
test('quarterly: saving replaces the same quarter; only typed values are stored', async () => {
  const log = [];
  const pool = { query: async (sql, params) => { log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return { rows: [] }; } };
  await saveQuarter(pool, { quarter: '2026-Q3', lost_sales_inr: 5, writeoffs_inr: 6 });
  assert.match(log[0].sql, /ON CONFLICT \(quarter\) DO UPDATE/);
  assert.deepEqual(log[0].params, ['2026-Q3', 5, 6]);
  await listQuarters(pool);
  assert.match(log[1].sql, /ORDER BY quarter DESC/);
});

test('run overview: totals per run, not decided = to review minus decided, hours to first and last decision', async () => {
  const runAt = new Date('2026-10-23T02:00:00Z');
  const pool = { query: async () => ({ rows: [
    { id: 5, run_at: runAt, as_of_date: '2026-10-19', triggered_by: 'cron', festival_month: true, lines_to_review: 8, high_demand: 1, stockout_risk: 5, overstock_risk: 2, exceptions: 1, approved: 4, overridden: 1,
      first_decision: new Date('2026-10-23T03:30:00Z'), last_decision: new Date('2026-10-23T08:00:00Z') },
    { id: 4, run_at: runAt, as_of_date: '2026-10-19', triggered_by: 'manual', festival_month: true, lines_to_review: 3, high_demand: 0, stockout_risk: 3, overstock_risk: 0, exceptions: 0, approved: 0, overridden: 0, first_decision: null, last_decision: null },
  ] }) };
  const [a, b] = await runOverview(pool);
  assert.deepEqual(a.flags_by_type, { high_demand: 1, stockout_risk: 5, overstock_risk: 2 });
  assert.equal(a.not_decided, 3);
  assert.equal(a.hours_to_first_decision, 1.5);
  assert.equal(a.hours_to_last_decision, 6);
  assert.equal(b.not_decided, 3);
  assert.equal(b.hours_to_first_decision, null); // no decisions yet: shown as a dash, not as 0
  assert.equal(b.hours_to_last_decision, null);
  for (const row of [a, b]) {
    assert.ok(!Object.keys(row).some((k) => /user|person|name|rank|score|who/i.test(k)), 'no individual people, no ranking');
  }
});

test("Deepa's page has no approve, override, run, upload or SKU controls", () => {
  const html = readFileSync(new URL('../views/deepa.html', import.meta.url), 'utf8');
  assert.ok(!/<button[^>]*>[^<]*(Approve|Override)/i.test(html), 'no approve or override buttons');
  for (const forbidden of ['data-approve', 'data-override', '/api/decide', '/api/run', '/api/upload', '/api/skus', 'Run now']) {
    assert.ok(!html.includes(forbidden), `deepa.html must not contain ${forbidden}`);
  }
  assert.ok(html.includes('No distributor-level order data loaded yet'));
  assert.ok(!/rank|score/i.test(html.replace(/predict, score or rank/g, '')), 'no ranking or scoring');
});

test('the page route serves Deepa at ?view=deepa, the dashboard by default, and 404 for anything else', async () => {
  const get = async (url) => { const res = fakeRes(); await page({ method: 'GET', url, headers: {} }, res); return res; };
  const deepa = await get('/api/page?view=deepa');
  assert.equal(deepa.statusCode, 200);
  assert.match(deepa.body, /Deepa's dashboard/);
  assert.ok(!deepa.body.includes('Run now'));
  const main = await get('/api/page');
  assert.match(main.body, /Run now/);
  assert.equal((await get('/api/page?view=../../.env')).statusCode, 404);
  assert.equal((await get('/api/page?view=constructor')).statusCode, 404);
});

test('the two dashboards link to each other, and every address for Deepa\'s page is routed', () => {
  const main = readFileSync(new URL('../views/dashboard.html', import.meta.url), 'utf8');
  const deepa = readFileSync(new URL('../views/deepa.html', import.meta.url), 'utf8');
  assert.ok(main.includes('href="/deepa"'));
  assert.ok(deepa.includes('href="/"'));
  const rewrites = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')).rewrites;
  for (const src of ['/deepa', '/deepa/', '/deepa.html']) {
    assert.ok(rewrites.some((r) => r.source === src && r.destination === '/api/page?view=deepa'), `${src} must be routed to Deepa's page`);
  }
});

test('financial-year quarters run April to March and show their date range', () => {
  assert.deepEqual(quarterRange('2026-Q1'), { fy: 'FY2026-27', quarter_no: 1, range: 'Apr–Jun 2026', label: 'Q1 FY2026-27 · Apr–Jun 2026' });
  assert.equal(quarterRange('2026-Q2').range, 'Jul–Sep 2026');
  assert.equal(quarterRange('2026-Q3').range, 'Oct–Dec 2026');       // the example: Q3 of FY2026-27
  assert.equal(quarterRange('2026-Q4').range, 'Jan–Mar 2027');       // Q4 falls in the next calendar year
  assert.equal(quarterRange('2026-Q4').fy, 'FY2026-27');
  assert.equal(quarterRange('2099-Q4').fy, 'FY2099-00');
  assert.equal(quarterRange('2026-Q5'), null);
  assert.equal(quarterRange('Q3 2026'), null);
  assert.match(validateQuarter({ quarter: 'bad', lost_sales_inr: 1, writeoffs_inr: 1 }).errors[0], /financial year starts in April/);
});
