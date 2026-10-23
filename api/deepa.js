import { withPool } from '../lib/db.js';
import { requirePassword } from '../lib/auth.js';
import { runOverview } from '../lib/deepa.js';
import { validateQuarter, saveQuarter, listQuarters, quarterRange } from '../lib/quarterly.js';
import { safe, sendJson, readJson } from '../lib/http.js';

// Deepa's overview: run history, review totals, quarterly results, active rules.
// It has no approve or override. The only thing she can write here is her own quarterly numbers.
export default safe(async (req, res) => {
  if (!requirePassword(req, res)) return;
  if (req.method === 'GET') {
    const data = await withPool(async (pool) => ({
      runs: await runOverview(pool),
      settings: (await pool.query(
        `SELECT key, value::float8 AS value, description FROM rule_settings
         UNION ALL SELECT key, value::float8, description FROM app_settings WHERE key LIKE 'distributor\\_%'
         ORDER BY key`)).rows,
      quarterly: (await listQuarters(pool)).map((r) => ({ ...r, ...quarterRange(r.quarter) })),
    }));
    return sendJson(res, 200, data);
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use GET or POST.' });

  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { errors: ['The request is not valid JSON.'] });
  }
  if (!body || body.action !== 'quarter') return sendJson(res, 400, { errors: ['Unknown action.'] });
  const checked = validateQuarter(body);
  if (checked.errors) return sendJson(res, 400, { ok: false, errors: checked.errors });
  await withPool((pool) => saveQuarter(pool, checked.value));
  sendJson(res, 200, { ok: true, quarter: checked.value.quarter, label: quarterRange(checked.value.quarter).label });
});
