import { parseCsv, validateSales, validateInventory, validateOrders } from './validate.js';
import { upsert } from './sql.js';

const MAX_ERRORS_SHOWN = 20;

function capErrors(errors) {
  if (errors.length <= MAX_ERRORS_SHOWN) return errors;
  return [...errors.slice(0, MAX_ERRORS_SHOWN), `...and ${errors.length - MAX_ERRORS_SHOWN} more problems.`];
}

function readFile(label, text, validate, errors) {
  let records;
  try {
    records = parseCsv(text);
  } catch (e) {
    errors.push(`${label}: cannot read CSV (${e.message})`);
    return null;
  }
  if (!records.length) {
    errors.push(`${label}: the file has no data rows.`);
    return null;
  }
  const res = validate(records);
  errors.push(...res.errors);
  return res.rows;
}

// Pure. Checks the uploaded SAP files and says what loading them would do. Writes nothing.
// files: { salesText, inventoryText, ordersText, illustrative } (each file may be empty).
// illustrative: true marks the orders file as demo data, not Freshroots data.
// context: { skuIds: Set (all SKUs, for validation), activeSkuIds: Set (optional), distributorIds: Set,
//            existingSalesKeys: Set of "SKU/week", existingOrderKeys: Set of "DIST/month" }
export function planUpload({ salesText, inventoryText, ordersText, illustrative }, { skuIds, activeSkuIds, distributorIds = new Set(), existingSalesKeys, existingOrderKeys = new Set() }) {
  const errors = [];
  if (!salesText && !inventoryText && !ordersText) errors.push('Choose at least one file: weekly sales, current stock or distributor orders.');
  if (illustrative && !ordersText) errors.push('The illustrative label applies to the distributor orders file only. Choose that file or untick the label.');

  const sales = salesText ? readFile('sales', salesText, (r) => validateSales(r, skuIds), errors) : [];
  const inventory = inventoryText ? readFile('stock', inventoryText, (r) => validateInventory(r, skuIds), errors) : [];
  const orders = ordersText ? readFile('orders', ordersText, (r) => validateOrders(r, distributorIds), errors) : [];
  if (errors.length) return { errors: capErrors(errors), sales: [], inventory: [], orders: [], summary: null };

  const summary = { sales_rows: sales.length, sales_new: 0, sales_corrected: 0, weeks_from: null, weeks_to: null,
    inventory_rows: inventory.length, as_of_dates: [], skus_missing_stock: [],
    orders_rows: orders.length, orders_new: 0, orders_corrected: 0, orders_from: null, orders_to: null, illustrative: Boolean(illustrative && orders.length) };

  for (const r of sales) {
    if (existingSalesKeys.has(`${r.sku_id}/${r.week}`)) summary.sales_corrected += 1;
    else summary.sales_new += 1;
  }
  if (sales.length) {
    const weeks = sales.map((r) => r.week).sort();
    summary.weeks_from = weeks[0];
    summary.weeks_to = weeks[weeks.length - 1];
  }
  if (inventory.length) {
    summary.as_of_dates = [...new Set(inventory.map((r) => r.as_of_date))].sort();
    const have = new Set(inventory.map((r) => r.sku_id));
    // Inactive SKUs are not expected to have stock rows.
    summary.skus_missing_stock = [...(activeSkuIds || skuIds)].filter((id) => !have.has(id)).sort();
  }
  for (const r of orders) {
    if (existingOrderKeys.has(`${r.distributor_id}/${r.month}`)) summary.orders_corrected += 1;
    else summary.orders_new += 1;
  }
  if (orders.length) {
    const months = orders.map((r) => r.month).sort();
    summary.orders_from = months[0];
    summary.orders_to = months[months.length - 1];
  }
  return { errors: [], sales, inventory, orders, illustrative: summary.illustrative, summary };
}

export async function loadPlanContext(pool) {
  const skuRows = (await pool.query('SELECT sku_id, active FROM skus')).rows;
  const skuIds = new Set(skuRows.map((r) => r.sku_id));
  const activeSkuIds = new Set(skuRows.filter((r) => r.active).map((r) => r.sku_id));
  const existingSalesKeys = new Set(
    (await pool.query('SELECT sku_id, week FROM sales_weekly')).rows.map((r) => `${r.sku_id}/${r.week}`),
  );
  const distributorIds = new Set((await pool.query('SELECT distributor_id FROM distributors')).rows.map((r) => r.distributor_id));
  const existingOrderKeys = new Set(
    (await pool.query('SELECT distributor_id, month FROM distributor_orders_monthly')).rows.map((r) => `${r.distributor_id}/${r.month}`),
  );
  return { skuIds, activeSkuIds, distributorIds, existingSalesKeys, existingOrderKeys };
}

// Writes a checked plan in one transaction. Sales are added or corrected by SKU and week.
// Stock replaces the whole snapshot, because it is one row per SKU as of a date.
export async function applyUpload(pool, plan) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await upsert(client, 'sales_weekly', ['sku_id', 'week'], ['sku_id', 'week', 'units_sold'], plan.sales);
    if (plan.inventory.length) {
      await client.query('DELETE FROM inventory');
      await upsert(client, 'inventory', ['sku_id'], ['sku_id', 'location', 'units_on_hand', 'as_of_date'], plan.inventory);
    }
    const orders = plan.orders || [];
    if (orders.length) {
      // Re-uploading a month replaces it, including its illustrative label.
      await upsert(client, 'distributor_orders_monthly', ['distributor_id', 'month'], ['distributor_id', 'month', 'order_volume', 'illustrative'],
        orders.map((r) => ({ ...r, illustrative: Boolean(plan.illustrative) })));
    }
    await client.query(
      'INSERT INTO data_uploads (sales_rows, sales_new, inventory_rows, orders_rows, illustrative) VALUES ($1, $2, $3, $4, $5)',
      [plan.sales.length, plan.summary.sales_new, plan.inventory.length, orders.length, Boolean(plan.illustrative)],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function lastUpload(pool) {
  const { rows } = await pool.query(
    'SELECT uploaded_at, sales_rows, sales_new, inventory_rows, orders_rows, illustrative FROM data_uploads ORDER BY id DESC LIMIT 1',
  );
  return rows[0] || null;
}

// Removes ONLY rows that were labelled illustrative when uploaded. Real order rows are never touched.
export async function removeIllustrativeOrders(pool) {
  const res = await pool.query('DELETE FROM distributor_orders_monthly WHERE illustrative');
  return res.rowCount;
}
