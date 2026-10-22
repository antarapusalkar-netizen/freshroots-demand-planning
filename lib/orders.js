import { zohoConfig } from './zoho-config.js';

// What the dashboard shows about Zoho. If Zoho is not connected or the last sync failed,
// the page shows that, never a zero or an empty value that looks real.
export async function zohoState(pool, env = process.env) {
  let cfg;
  try {
    cfg = zohoConfig(env);
  } catch (e) {
    return { state: 'failed', message: e.message, last_ok_at: null };
  }
  if (!cfg) return { state: 'not_connected' };

  const last = (await pool.query('SELECT ok, message FROM zoho_sync_log ORDER BY id DESC LIMIT 1')).rows[0];
  if (!last) return { state: 'never_synced' };
  const ok = (await pool.query('SELECT max(synced_at) AS t FROM zoho_sync_log WHERE ok')).rows[0];
  return { state: last.ok ? 'ok' : 'failed', message: last.message, last_ok_at: ok.t };
}

export async function openOrderLines(pool) {
  const { rows } = await pool.query(
    `SELECT zoho_po_id, line_item_id, po_number, status, item_ref, sku_id,
            quantity::float8 AS quantity, quantity_received::float8 AS quantity_received,
            to_char(expected_date, 'YYYY-MM-DD') AS expected_date
       FROM purchase_orders ORDER BY po_number, line_item_id`,
  );
  return rows;
}

// Pure: attach on-order lines to each flag row, and list the lines that matched no SKU.
export function attachOrders(flagRows, orderLines) {
  const bySku = new Map();
  for (const o of orderLines) {
    if (!o.sku_id) continue;
    if (!bySku.has(o.sku_id)) bySku.set(o.sku_id, []);
    bySku.get(o.sku_id).push(o);
  }
  return {
    rows: flagRows.map((f) => ({ ...f, on_order: bySku.get(f.sku_id) || [] })),
    unmatched: orderLines.filter((o) => !o.sku_id),
  };
}
