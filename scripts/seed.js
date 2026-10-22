// Loads and validates the five SAP CSVs, then writes them to Neon in one transaction.
// Safe to re-run: rows are upserted by their keys.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect } from '../lib/db.js';
import { validateAll } from '../lib/validate.js';

const dataDir = new URL('../data/', import.meta.url);
const FILES = {
  distributors: 'distributor_seed_data.csv',
  skus: 'sku_seed_data.csv',
  sales: 'weekly_sales_seed_data.csv',
  inventory: 'current_inventory_seed_data.csv',
  calendar: 'calendar_seed_data.csv',
};

// table, key columns, and the validated row fields to write
const TABLES = [
  ['distributors', 'distributors', ['distributor_id'], ['distributor_id', 'distributor_name', 'region', 'status']],
  ['skus', 'skus', ['sku_id'], ['sku_id', 'sku_name', 'category', 'perishability', 'standard_reorder_qty', 'unit_of_measure', 'distributor_id']],
  ['sales', 'sales_weekly', ['sku_id', 'week'], ['sku_id', 'week', 'units_sold']],
  ['inventory', 'inventory', ['sku_id'], ['sku_id', 'location', 'units_on_hand', 'as_of_date']],
  ['calendar', 'calendar', ['year', 'month'], ['year', 'month', 'year_month', 'is_festival_month']],
];

// Default thresholds from CLAUDE.md section 7 (assumptions A1-A3 are named settings).
const RULE_SETTINGS = [
  ['recent_weeks', 4, 'Weeks in the "recent sales" window (rule 1)'],
  ['average_weeks', 12, 'Weeks in the long average; also the minimum history needed (rule 1, A3)'],
  ['high_demand_pct', 20, 'Recent sales must exceed the average by this percent (rule 1)'],
  ['high_demand_multiplier', 1.5, 'Reorder multiple of the standard quantity for high demand (rule 1)'],
  ['stockout_weeks', 6, 'Stock below this many weeks of sales is stockout risk (rule 2)'],
  ['overstock_weeks', 14, 'Stock above this many weeks of sales is overstock risk (rule 3)'],
  ['festival_uplift_pct', 25, 'Demand uplift in festival months (rule 4)'],
  ['perishable_min_weeks', 3, 'Perishable stockout threshold, replaces rule 2 (rule 5, A1)'],
  ['perishable_max_weeks', 4, 'Perishable overstock threshold, replaces rule 3 (rule 5, A1)'],
];

async function upsert(client, table, keys, cols, rows) {
  if (!rows.length) return;
  const updates = cols.filter((c) => !keys.includes(c));
  const set = updates.length
    ? `DO UPDATE SET ${updates.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`
    : 'DO NOTHING';
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const params = [];
    const tuples = chunk.map((r) => `(${cols.map((c) => { params.push(r[c]); return `$${params.length}`; }).join(', ')})`);
    await client.query(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT (${keys.join(', ')}) ${set}`,
      params,
    );
  }
}

async function main() {
  const text = {};
  for (const [name, file] of Object.entries(FILES)) {
    text[name] = readFileSync(new URL(file, dataDir), 'utf8');
  }
  const { data, errors } = validateAll(text);
  if (errors.length) {
    console.error(`Validation failed. Nothing was loaded.\n- ${errors.join('\n- ')}`);
    process.exit(1);
  }
  console.log('Validation passed.');

  const pool = connect();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(readFileSync(fileURLToPath(new URL('schema.sql', import.meta.url)), 'utf8'));
    for (const [name, table, keys, cols] of TABLES) {
      await upsert(client, table, keys, cols, data[name]);
    }
    for (const [key, value, description] of RULE_SETTINGS) {
      await client.query(
        'INSERT INTO rule_settings (key, value, description) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING',
        [key, value, description],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`Load failed and was rolled back: ${e.message}`);
    process.exitCode = 1;
    return;
  } finally {
    client.release();
  }

  for (const table of ['distributors', 'skus', 'sales_weekly', 'inventory', 'calendar', 'rule_settings']) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    console.log(`${table}: ${rows[0].n}`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(`Seed error: ${e.message}`);
  process.exit(1);
});
