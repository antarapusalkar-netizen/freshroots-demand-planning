import { parseCsv, validateSales, validateInventory } from './validate.js';
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
// files: { salesText, inventoryText } (either may be empty).
// context: { skuIds: Set, existingSalesKeys: Set of "SKU/week" }
export function planUpload({ salesText, inventoryText }, { skuIds, existingSalesKeys }) {
  const errors = [];
  if (!salesText && !inventoryText) errors.push('Choose at least one file: weekly sales or current stock.');

  const sales = salesText ? readFile('sales', salesText, (r) => validateSales(r, skuIds), errors) : [];
  const inventory = inventoryText ? readFile('stock', inventoryText, (r) => validateInventory(r, skuIds), errors) : [];
  if (errors.length) return { errors: capErrors(errors), sales: [], inventory: [], summary: null };

  const summary = { sales_rows: sales.length, sales_new: 0, sales_corrected: 0, weeks_from: null, weeks_to: null,
    inventory_rows: inventory.length, as_of_dates: [], skus_missing_stock: [] };

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
    summary.skus_missing_stock = [...skuIds].filter((id) => !have.has(id)).sort();
  }
  return { errors: [], sales, inventory, summary };
}

export async function loadPlanContext(pool) {
  const skuIds = new Set((await pool.query('SELECT sku_id FROM skus')).rows.map((r) => r.sku_id));
  const existingSalesKeys = new Set(
    (await pool.query('SELECT sku_id, week FROM sales_weekly')).rows.map((r) => `${r.sku_id}/${r.week}`),
  );
  return { skuIds, existingSalesKeys };
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
    await client.query(
      'INSERT INTO data_uploads (sales_rows, sales_new, inventory_rows) VALUES ($1, $2, $3)',
      [plan.sales.length, plan.summary.sales_new, plan.inventory.length],
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
    'SELECT uploaded_at, sales_rows, sales_new, inventory_rows FROM data_uploads ORDER BY id DESC LIMIT 1',
  );
  return rows[0] || null;
}
