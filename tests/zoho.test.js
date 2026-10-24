import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zohoConfig } from '../lib/zoho-config.js';
import { getAccessToken, pullOpenOrders, syncZoho, normalizeStatus } from '../lib/zoho.js';
import { zohoState, attachOrders } from '../lib/orders.js';
import { evaluateAll } from '../lib/rules.js';
import { validateAll } from '../lib/validate.js';
import { settingsFromRows } from '../lib/settings.js';

const ENV = { ZOHO_CLIENT_ID: 'cid', ZOHO_CLIENT_SECRET: 'csecret', ZOHO_REFRESH_TOKEN: 'rtoken', ZOHO_ORG_ID: '999', ZOHO_DC: 'in' };
const cfg = zohoConfig(ENV);
const KNOWN = new Set(['SKU001', 'SKU002', 'SKU003']);
const OPEN = ['issued', 'partially_received'];

// A mocked Zoho. Responses are built only from fields the Zoho docs name.
function mockZoho({ pos, items, details = {}, failWith, pageSize }) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ method: opts.method || 'GET', host: u.host, path: u.pathname, query: u.searchParams, headers: opts.headers, body: opts.body ? String(opts.body) : null, url: String(url) });
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (u.host.startsWith('accounts.')) return failWith === 'token' ? json(400, { error: 'invalid_code' }) : json(200, { access_token: 'tok123', expires_in: 3600 });
    if (failWith === 401) return json(401, { code: 57, message: 'You are not authorized' });
    if (failWith === 429) return json(429, {});
    const page = Number(u.searchParams.get('page') || 1);
    const slice = (arr) => (pageSize ? arr.slice((page - 1) * pageSize, page * pageSize) : arr);
    const ctx = (arr) => (pageSize ? { page_context: { has_more_page: page * pageSize < arr.length } } : {});
    if (u.pathname.endsWith('/purchaseorders')) return json(200, { code: 0, message: 'success', purchaseorders: slice(pos), ...ctx(pos) });
    if (u.pathname.endsWith('/items')) return json(200, { code: 0, message: 'success', items: slice(items), ...ctx(items) });
    const m = /\/purchaseorders\/(.+)$/.exec(u.pathname);
    if (m && details[m[1]]) return json(200, { code: 0, message: 'success', purchaseorder: details[m[1]] });
    return json(404, { code: 5, message: 'not found' });
  };
  return { fetchFn, calls };
}

const items = [
  { item_id: 'i1', sku: 'SKU001' }, { item_id: 'i2', sku: 'SKU002' },
  { item_id: 'i3', sku: 'sku003' }, { item_id: 'i4', sku: '' }, { item_id: 'i5', sku: 'SKU999' },
];
const pos = [
  { purchaseorder_id: 'p1', purchaseorder_number: 'PO-1', status: 'issued', expected_delivery_date: '2026-11-02',
    line_items: [{ line_item_id: 'l1', item_id: 'i1', quantity: 500, quantity_received: 0 }] },
  { purchaseorder_id: 'p2', purchaseorder_number: 'PO-2', status: 'Partially_Received', expected_delivery_date: '2026-11-05' }, // no line_items in list
  { purchaseorder_id: 'p3', purchaseorder_number: 'PO-3', status: 'draft', line_items: [{ item_id: 'i1', quantity: 1 }] },
  { purchaseorder_id: 'p4', purchaseorder_number: 'PO-4', status: 'cancelled', line_items: [{ item_id: 'i1', quantity: 1 }] },
];
const details = { p2: { line_items: [
  { line_item_id: 'l2', item_id: 'i2', quantity: 300, quantity_received: 120 },
  { line_item_id: 'l3', item_id: 'i3', quantity: 10 },   // 'sku003' is not 'SKU003': no guessing
  { line_item_id: 'l4', item_id: 'i4', quantity: 7 },    // item has no SKU
  { line_item_id: 'l5', item_id: 'i5', quantity: 8 },    // SKU not ours
  { line_item_id: 'l6', item_id: 'i404', quantity: 9 },  // item not found
] } };

test('config: null when Zoho variables are missing; bad data center rejected; URLs follow ZOHO_DC', () => {
  assert.equal(zohoConfig({}), null);
  assert.equal(zohoConfig({ ...ENV, ZOHO_ORG_ID: '' }), null);
  assert.throws(() => zohoConfig({ ...ENV, ZOHO_DC: 'evil.com/x#' }), /ZOHO_DC/);
  assert.equal(cfg.apiUrl, 'https://www.zohoapis.in/inventory/v1');
  assert.equal(cfg.accountsUrl, 'https://accounts.zoho.in');
  assert.equal(zohoConfig({ ...ENV, ZOHO_DC: undefined }).dc, 'in');
});

test('token refresh: POST to accounts host, secrets in the body only', async () => {
  const { fetchFn, calls } = mockZoho({ pos: [], items: [] });
  assert.equal(await getAccessToken(cfg, fetchFn), 'tok123');
  const c = calls[0];
  assert.equal(c.method, 'POST');
  assert.equal(c.url, 'https://accounts.zoho.in/oauth/v2/token');
  assert.match(c.body, /grant_type=refresh_token/);
  assert.match(c.body, /refresh_token=rtoken/);
  assert.ok(!c.url.includes('csecret') && !c.url.includes('rtoken'));
});

test('token refresh failure gives a clear error without secrets', async () => {
  const { fetchFn } = mockZoho({ pos: [], items: [], failWith: 'token' });
  await assert.rejects(() => getAccessToken(cfg, fetchFn), (e) => /token refresh failed: invalid_code/.test(e.message) && !/csecret|rtoken/.test(e.message));
});

test('pull: only open statuses, lines matched by exact SKU code, rest unmatched', async () => {
  const { fetchFn, calls } = mockZoho({ pos, items, details });
  const { rows, message } = await pullOpenOrders(cfg, 'tok', { openStatuses: OPEN, knownSkuIds: KNOWN }, fetchFn);
  assert.deepEqual(rows.map((r) => [r.po_number, r.line_item_id, r.sku_id]), [
    ['PO-1', 'l1', 'SKU001'], ['PO-2', 'l2', 'SKU002'], ['PO-2', 'l3', null], ['PO-2', 'l4', null], ['PO-2', 'l5', null], ['PO-2', 'l6', null],
  ]);
  const l2 = rows.find((r) => r.line_item_id === 'l2');
  assert.equal(l2.quantity, 300);
  assert.equal(l2.quantity_received, 120);
  assert.equal(l2.expected_date, '2026-11-05');
  assert.equal(l2.status, 'Partially_Received'); // stored as Zoho returned it
  assert.equal(rows[0].quantity_received, 0);
  assert.equal(rows.find((r) => r.line_item_id === 'l3').quantity_received, null); // not returned: stays unknown
  assert.match(message, /2 open of 4 purchase orders/);
  assert.match(message, /draft 1/);
  assert.match(message, /cancelled 1/);
  // detail fetched only for the open PO whose list entry had no line items
  assert.deepEqual(calls.filter((c) => /purchaseorders\/.+/.test(c.path)).map((c) => c.path.split('/').pop()), ['p2']);
});

test('every call to the Inventory API is a GET with the org id and token header', async () => {
  const { fetchFn, calls } = mockZoho({ pos, items, details });
  await pullOpenOrders(cfg, 'tok', { openStatuses: OPEN, knownSkuIds: KNOWN }, fetchFn);
  assert.ok(calls.length >= 3);
  for (const c of calls) {
    assert.equal(c.host, 'www.zohoapis.in');
    assert.equal(c.method, 'GET');
    assert.equal(c.query.get('organization_id'), '999');
    assert.equal(c.headers.Authorization, 'Zoho-oauthtoken tok');
    assert.equal(c.body, null);
  }
});

test('the Zoho client source has no create, update or delete call', () => {
  const src = readFileSync(new URL('../lib/zoho.js', import.meta.url), 'utf8');
  const methods = [...src.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(methods)].sort(), ['GET', 'POST']); // POST is only the OAuth token refresh
  assert.equal([...src.matchAll(/method:\s*'POST'/g)].length, 1);
});

test('pagination: follows has_more_page; stops on a short page when it is absent', async () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ purchaseorder_id: `p${i}`, purchaseorder_number: `N${i}`, status: 'issued', line_items: [{ line_item_id: `l${i}`, item_id: 'i1', quantity: 1 }] }));
  const a = mockZoho({ pos: many, items, pageSize: 2 });
  const r = await pullOpenOrders(cfg, 'tok', { openStatuses: OPEN, knownSkuIds: KNOWN }, a.fetchFn);
  assert.equal(r.rows.length, 5);
  assert.equal(a.calls.filter((c) => c.path.endsWith('/purchaseorders')).length, 3);
  const b = mockZoho({ pos: many, items });
  assert.equal((await pullOpenOrders(cfg, 'tok', { openStatuses: OPEN, knownSkuIds: KNOWN }, b.fetchFn)).rows.length, 5);
  assert.equal(b.calls.filter((c) => c.path.endsWith('/purchaseorders')).length, 1);
});

test('status names are normalised for comparison', () => {
  assert.equal(normalizeStatus('Partially_Received'), 'partially_received');
  assert.equal(normalizeStatus(' Partially Received '), 'partially_received');
  assert.equal(normalizeStatus(undefined), '');
});

test('unexpected response shapes are errors, not guesses', async () => {
  const noList = { fetchFn: async (url) => (String(url).includes('accounts') ? { ok: true, status: 200, json: async () => ({ access_token: 't' }) } : { ok: true, status: 200, json: async () => ({ code: 0, nothing: [] }) }) };
  await assert.rejects(() => pullOpenOrders(cfg, 't', { openStatuses: OPEN, knownSkuIds: KNOWN }, noList.fetchFn), /no "purchaseorders" list/);
  const noQty = mockZoho({ pos: [{ purchaseorder_id: 'p', purchaseorder_number: 'PO-9', status: 'issued', line_items: [{ item_id: 'i1' }] }], items });
  await assert.rejects(() => pullOpenOrders(cfg, 't', { openStatuses: OPEN, knownSkuIds: KNOWN }, noQty.fetchFn), /no quantity/);
});

// ---- syncZoho with a recording fake database ----
function fakePool({ statuses = 'issued,partially_received' } = {}) {
  const log = [];
  const run = async (sql, params) => {
    log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (/FROM app_settings/.test(sql)) return { rows: [{ value: statuses }] };
    if (/FROM skus/.test(sql)) return { rows: [...KNOWN].map((sku_id) => ({ sku_id })) };
    return { rows: [] };
  };
  return { log, query: run, connect: async () => ({ query: run, release() {} }) };
}

test('sync without Zoho variables: not connected, no network call, nothing written', async () => {
  const pool = fakePool();
  const { fetchFn, calls } = mockZoho({ pos, items, details });
  const r = await syncZoho(pool, {}, fetchFn);
  assert.equal(r.state, 'not_connected');
  assert.equal(calls.length, 0);
  assert.equal(pool.log.length, 0);
});

test('sync success: replaces the snapshot in one transaction and logs ok', async () => {
  const pool = fakePool();
  const { fetchFn } = mockZoho({ pos, items, details });
  const r = await syncZoho(pool, ENV, fetchFn);
  assert.equal(r.state, 'ok');
  assert.equal(r.rows, 6);
  const sql = pool.log.map((l) => l.sql);
  const iBegin = sql.indexOf('BEGIN'), iDel = sql.indexOf('DELETE FROM purchase_orders'), iCommit = sql.indexOf('COMMIT');
  assert.ok(iBegin >= 0 && iDel > iBegin && iCommit > iDel);
  assert.equal(sql.filter((s) => s.startsWith('INSERT INTO purchase_orders')).length, 6);
  assert.ok(sql.some((s) => s.startsWith('INSERT INTO zoho_sync_log (ok, message, rows_pulled) VALUES (true')));
});

for (const [label, failWith, pattern] of [['401', 401, /HTTP 401.*not authorized/], ['429', 429, /rate limit/], ['token', 'token', /token refresh failed/]]) {
  test(`sync failure (${label}): reports failed, logs it, keeps the old snapshot`, async () => {
    const pool = fakePool();
    const { fetchFn } = mockZoho({ pos, items, details, failWith });
    const r = await syncZoho(pool, ENV, fetchFn);
    assert.equal(r.state, 'failed');
    assert.match(r.message, pattern);
    const sql = pool.log.map((l) => l.sql);
    assert.ok(!sql.includes('DELETE FROM purchase_orders'), 'old orders must stay');
    const logged = pool.log.find((l) => l.sql.startsWith('INSERT INTO zoho_sync_log'));
    assert.equal(logged.params[0], false);
    assert.ok(!/csecret|rtoken/.test(JSON.stringify(pool.log)));
  });
}

test('sync with a bad ZOHO_DC fails cleanly', async () => {
  const r = await syncZoho(fakePool(), { ...ENV, ZOHO_DC: 'nope' }, mockZoho({ pos, items }).fetchFn);
  assert.equal(r.state, 'failed');
  assert.match(r.message, /ZOHO_DC/);
});

// ---- What the dashboard is told ----
function statePool(logRow, okRow = { t: new Date('2026-10-22T10:00:00Z') }) {
  return { query: async (sql) => ({ rows: /max\(synced_at\)/.test(sql) ? [okRow] : logRow ? [logRow] : [] }) };
}
test('zohoState: not connected even if old sync rows exist', async () => {
  assert.equal((await zohoState(statePool({ ok: true, message: 'x' }), {})).state, 'not_connected');
});
test('zohoState: never synced, ok, failed', async () => {
  assert.equal((await zohoState(statePool(null), ENV)).state, 'never_synced');
  assert.equal((await zohoState(statePool({ ok: true, message: 'fine' }), ENV)).state, 'ok');
  const f = await zohoState(statePool({ ok: false, message: 'HTTP 401' }), ENV);
  assert.equal(f.state, 'failed');
  assert.equal(f.message, 'HTTP 401');
  assert.ok(f.last_ok_at);
});

test('attachOrders: on-order lines by SKU; unmatched listed separately; a flag with no orders gets an empty list', () => {
  const lines = [{ sku_id: 'SKU001', quantity: 5 }, { sku_id: 'SKU001', quantity: 6 }, { sku_id: null, quantity: 9 }];
  const out = attachOrders([{ sku_id: 'SKU001' }, { sku_id: 'SKU002' }], lines);
  assert.equal(out.rows[0].on_order.length, 2);
  assert.deepEqual(out.rows[1].on_order, []);
  assert.equal(out.unmatched.length, 1);
});

test('open orders never change a flag: the rules engine has no way to see them', () => {
  const read = (f) => readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8');
  const { data } = validateAll({ distributors: read('distributor_seed_data.csv'), skus: read('sku_seed_data.csv'), sales: read('weekly_sales_seed_data.csv'), inventory: read('current_inventory_seed_data.csv'), calendar: read('calendar_seed_data.csv') });
  const S = settingsFromRows(Object.entries({ recent_weeks: 4, average_weeks: 12, high_demand_pct: 20, high_demand_multiplier: 1.5, stockout_weeks: 6, overstock_weeks: 14, festival_uplift_pct: 25, perishable_min_weeks: 3, perishable_max_weeks: 4 }).map(([key, value]) => ({ key, value })));
  const plain = evaluateAll(data, S);
  const withOrders = evaluateAll({ ...data, purchase_orders: [{ sku_id: 'SKU001', quantity: 99999 }] }, S);
  assert.deepEqual(withOrders, plain);
  for (const f of ['rules.js', 'store.js']) {
    assert.ok(!/purchase_orders|orders/.test(readFileSync(new URL(`../lib/${f}`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')), `${f} must not read orders`);
  }
});

test('delivery date: a real purchase order has delivery_date filled and expected_delivery_date empty', async () => {
  const realShape = [
    { purchaseorder_id: 'p1', purchaseorder_number: 'PO-00001', status: 'issued', expected_delivery_date: '', delivery_date: '2026-11-09', line_items: [{ line_item_id: 'l1', item_id: 'i1', quantity: 500, quantity_received: 0 }] },
    { purchaseorder_id: 'p2', purchaseorder_number: 'PO-00002', status: 'issued', expected_delivery_date: '2026-11-20', delivery_date: '2026-11-09', line_items: [{ line_item_id: 'l2', item_id: 'i2', quantity: 5 }] },
    { purchaseorder_id: 'p3', purchaseorder_number: 'PO-00003', status: 'issued', expected_delivery_date: '', delivery_date: '', line_items: [{ line_item_id: 'l3', item_id: 'i3', quantity: 5 }] },
  ];
  const { fetchFn } = mockZoho({ pos: realShape, items });
  const { rows } = await pullOpenOrders(cfg, 'tok', { openStatuses: OPEN, knownSkuIds: KNOWN }, fetchFn);
  const due = Object.fromEntries(rows.map((r) => [r.po_number, r.expected_date]));
  assert.equal(due['PO-00001'], '2026-11-09'); // taken from delivery_date
  assert.equal(due['PO-00002'], '2026-11-20'); // expected_delivery_date wins when it holds a date
  assert.equal(due['PO-00003'], null);          // no date anywhere: stays unknown, not invented
});
