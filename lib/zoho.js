// Read-only Zoho Inventory client. Every call to the Inventory API is a GET.
// The only POST is the OAuth token refresh on the accounts host. Nothing here creates,
// updates or deletes anything in Zoho.
import { zohoConfig } from './zoho-config.js';

const PER_PAGE = 200;
const MAX_PAGES = 50;
const TIMEOUT_MS = 15000;

export function normalizeStatus(s) {
  return String(s ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export async function getAccessToken(cfg, fetchFn = fetch) {
  const body = new URLSearchParams({
    refresh_token: cfg.refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: 'refresh_token',
  });
  const res = await fetchFn(`${cfg.accountsUrl}/oauth/v2/token`, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Zoho token refresh failed${json.error ? `: ${json.error}` : ` (HTTP ${res.status})`}`);
  }
  return json.access_token;
}

async function zohoGet(cfg, token, path, params, fetchFn) {
  const url = new URL(cfg.apiUrl + path);
  url.searchParams.set('organization_id', cfg.orgId);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
  const res = await fetchFn(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 429) throw new Error('Zoho rate limit reached (HTTP 429). Try again later.');
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || (json.code !== undefined && json.code !== 0)) {
    throw new Error(`Zoho request ${path} failed (HTTP ${res.status})${json && json.message ? `: ${json.message}` : ''}`);
  }
  return json;
}

async function listAll(cfg, token, path, key, fetchFn) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const json = await zohoGet(cfg, token, path, { page, per_page: PER_PAGE }, fetchFn);
    const chunk = json[key];
    if (!Array.isArray(chunk)) throw new Error(`Unexpected Zoho response: no "${key}" list from ${path}`);
    all.push(...chunk);
    const ctx = json.page_context;
    const more = ctx && typeof ctx.has_more_page === 'boolean' ? ctx.has_more_page : chunk.length >= PER_PAGE;
    if (!more) return all;
  }
  throw new Error(`Zoho ${path} returned more than ${MAX_PAGES} pages; stopped.`);
}

const finite = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

// Pulls purchase orders in an open status and returns one row per line.
// A1/A7: a line matches our SKU only when the Zoho item's SKU code equals a SKU_ID exactly.
// Anything else stays unmatched (sku_id null). Never guessed.
export async function pullOpenOrders(cfg, token, { openStatuses, knownSkuIds }, fetchFn = fetch) {
  const open = new Set(openStatuses.map(normalizeStatus));
  const pos = await listAll(cfg, token, '/purchaseorders', 'purchaseorders', fetchFn);

  const seen = {};
  for (const po of pos) seen[po.status ?? '(none)'] = (seen[po.status ?? '(none)'] || 0) + 1;
  const openPos = pos.filter((po) => open.has(normalizeStatus(po.status)));

  const skuByItem = new Map();
  if (openPos.length) {
    for (const it of await listAll(cfg, token, '/items', 'items', fetchFn)) {
      skuByItem.set(String(it.item_id), typeof it.sku === 'string' ? it.sku.trim() : '');
    }
  }

  const rows = [];
  for (const po of openPos) {
    let lines = po.line_items;
    if (!Array.isArray(lines)) {
      const detail = await zohoGet(cfg, token, `/purchaseorders/${encodeURIComponent(po.purchaseorder_id)}`, {}, fetchFn);
      lines = detail.purchaseorder && detail.purchaseorder.line_items;
      if (!Array.isArray(lines)) throw new Error(`Unexpected Zoho response for purchase order ${po.purchaseorder_number}`);
    }
    const expected = typeof po.expected_delivery_date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(po.expected_delivery_date)
      ? po.expected_delivery_date.slice(0, 10) : null;
    lines.forEach((line, i) => {
      const qty = finite(line.quantity);
      if (qty === null) throw new Error(`Unexpected Zoho response: purchase order ${po.purchaseorder_number} has a line with no quantity`);
      const sku = skuByItem.get(String(line.item_id));
      rows.push({
        zoho_po_id: String(po.purchaseorder_id),
        line_item_id: line.line_item_id ? String(line.line_item_id) : `line${i}`,
        po_number: po.purchaseorder_number ?? null,
        status: String(po.status),
        item_ref: line.item_id ? String(line.item_id) : null,
        sku_id: sku && knownSkuIds.has(sku) ? sku : null,
        quantity: qty,
        quantity_received: finite(line.quantity_received),
        expected_date: expected,
      });
    });
  }
  const seenText = Object.entries(seen).map(([s, n]) => `${s} ${n}`).join(', ') || 'none';
  return {
    rows,
    message: `${openPos.length} open of ${pos.length} purchase orders, ${rows.length} lines. Statuses seen: ${seenText}.`,
  };
}

async function logSync(pool, ok, message, rows) {
  try {
    await pool.query('INSERT INTO zoho_sync_log (ok, message, rows_pulled) VALUES ($1, $2, $3)', [ok, message, rows]);
  } catch {
    /* the sync result is still returned even if the log write fails */
  }
}

// Never throws. A failed or missing sync must not block a run, and a failed sync keeps
// the previous snapshot of orders untouched.
export async function syncZoho(pool, env = process.env, fetchFn = fetch) {
  let cfg;
  try {
    cfg = zohoConfig(env);
  } catch (e) {
    await logSync(pool, false, e.message, 0);
    return { state: 'failed', message: e.message };
  }
  if (!cfg) return { state: 'not_connected' };

  try {
    const setting = await pool.query("SELECT value FROM app_settings WHERE key = 'zoho_open_statuses'");
    const openStatuses = (setting.rows[0] ? setting.rows[0].value : '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!openStatuses.length) throw new Error('zoho_open_statuses is empty in app_settings');
    const known = new Set((await pool.query('SELECT sku_id FROM skus')).rows.map((r) => r.sku_id));

    const token = await getAccessToken(cfg, fetchFn);
    const { rows, message } = await pullOpenOrders(cfg, token, { openStatuses, knownSkuIds: known }, fetchFn);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM purchase_orders');
      for (const r of rows) {
        await client.query(
          `INSERT INTO purchase_orders (zoho_po_id, line_item_id, po_number, status, item_ref, sku_id, quantity, quantity_received, expected_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [r.zoho_po_id, r.line_item_id, r.po_number, r.status, r.item_ref, r.sku_id, r.quantity, r.quantity_received, r.expected_date],
        );
      }
      await client.query('INSERT INTO zoho_sync_log (ok, message, rows_pulled) VALUES (true, $1, $2)', [message, rows.length]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return { state: 'ok', message, rows: rows.length };
  } catch (e) {
    await logSync(pool, false, e.message, 0);
    return { state: 'failed', message: e.message };
  }
}
