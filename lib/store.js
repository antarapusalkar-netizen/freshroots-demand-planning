import { evaluateAll } from './rules.js';
import { loadSettings } from './settings.js';
import { APPROVED_COLUMNS } from './csv.js';

const TABLE_ROWS = {
  skus: 'SELECT * FROM skus',
  inventory: "SELECT sku_id, location, units_on_hand, to_char(as_of_date, 'YYYY-MM-DD') AS as_of_date FROM inventory",
  sales: 'SELECT sku_id, week, units_sold FROM sales_weekly',
  calendar: 'SELECT year, month, year_month, is_festival_month FROM calendar',
};

export async function loadInputs(pool) {
  const out = {};
  for (const [k, sql] of Object.entries(TABLE_ROWS)) out[k] = (await pool.query(sql)).rows;
  return out;
}

// Pure: one flags row per SKU result.
export function flagRowsFromResults(results) {
  return results.map((r) => ({
    sku_id: r.sku_id,
    flag_types: r.flag_types,
    recommended_action: r.recommended_action,
    recommended_qty: r.recommended_qty,
    rule_reason: r.rule_reason,
    is_exception: r.is_exception,
  }));
}

// Runs the rules on what is in Neon and saves the run and its flags. Returns the run id.
export async function runRules(pool, triggeredBy) {
  const settings = await loadSettings(pool);
  const { asOfDate, festival, results } = evaluateAll(await loadInputs(pool), settings);
  const rows = flagRowsFromResults(results);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await client.query(
      'INSERT INTO runs (as_of_date, festival_month, triggered_by) VALUES ($1, $2, $3) RETURNING id',
      [asOfDate, festival, triggeredBy],
    );
    const runId = run.rows[0].id;
    for (const r of rows) {
      await client.query(
        `INSERT INTO flags (run_id, sku_id, flag_types, recommended_action, recommended_qty, rule_reason, is_exception)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [runId, r.sku_id, r.flag_types, r.recommended_action, r.recommended_qty, r.rule_reason, r.is_exception],
      );
    }
    await client.query('COMMIT');
    return runId;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function latestRun(pool) {
  const { rows } = await pool.query(
    "SELECT id, run_at, to_char(as_of_date, 'YYYY-MM-DD') AS as_of_date, festival_month, triggered_by FROM runs ORDER BY id DESC LIMIT 1",
  );
  return rows[0] || null;
}

export async function flagsForRun(pool, runId) {
  const { rows } = await pool.query(
    `SELECT f.id, f.sku_id, s.sku_name, f.flag_types, f.recommended_action, f.recommended_qty,
            f.rule_reason, f.ai_reason, f.is_exception, d.decision, d.override_qty, d.note, d.decided_at
       FROM flags f
       JOIN skus s ON s.sku_id = f.sku_id
       LEFT JOIN decisions d ON d.flag_id = f.id
      WHERE f.run_id = $1
      ORDER BY f.sku_id`,
    [runId],
  );
  return rows;
}

export async function getFlag(pool, flagId) {
  const { rows } = await pool.query(
    'SELECT f.id, f.run_id, f.flag_types, f.is_exception FROM flags f WHERE f.id = $1',
    [flagId],
  );
  return rows[0] || null;
}

export async function saveDecision(pool, d) {
  await pool.query(
    `INSERT INTO decisions (flag_id, decision, override_qty, note, decided_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (flag_id) DO UPDATE
       SET decision = EXCLUDED.decision, override_qty = EXCLUDED.override_qty,
           note = EXCLUDED.note, decided_at = now()`,
    [d.flag_id, d.decision, d.override_qty, d.note],
  );
}

// Pure: approved list rows for procurement. Approved lines use the recommended quantity;
// overridden lines use the quantity Raghav entered (blank if he gave none).
export function approvedRows(flagRows, runDate) {
  return flagRows
    .filter((f) => f.decision === 'approved' || f.decision === 'overridden')
    .map((f) => ({
      run_date: runDate,
      sku_id: f.sku_id,
      sku_name: f.sku_name,
      flags: f.flag_types.join(' + '),
      recommended_action: f.recommended_action,
      recommended_qty: f.recommended_qty,
      decision: f.decision,
      final_qty: f.decision === 'approved' ? f.recommended_qty : f.override_qty,
      note: f.note,
      decided_at: f.decided_at instanceof Date ? f.decided_at.toISOString() : f.decided_at,
    }));
}

export { APPROVED_COLUMNS };
