import { withPool } from '../lib/db.js';
import { getFlag, saveDecision, latestRun } from '../lib/store.js';
import { validateDecision } from '../lib/decisions.js';
import { requirePassword } from '../lib/auth.js';
import { safe, sendJson, readJson } from '../lib/http.js';

// Saves Approve or Override for one line of the latest run. Nothing is final until saved.
export default safe(async (req, res) => {
  if (!requirePassword(req, res)) return;
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { error: 'Request body is not valid JSON.' });
  }
  const result = await withPool(async (pool) => {
    const flag = await getFlag(pool, Number(body && body.flag_id));
    const checked = validateDecision(body, flag);
    if (checked.error) return { status: 400, body: { error: checked.error } };
    const run = await latestRun(pool);
    if (!run || flag.run_id !== run.id) {
      return { status: 409, body: { error: 'This line belongs to an older run. Reload the page.' } };
    }
    await saveDecision(pool, checked.value);
    return { status: 200, body: { ok: true } };
  });
  sendJson(res, result.status, result.body);
});
