import { withPool } from '../lib/db.js';
import { runRules, latestRun } from '../lib/store.js';
import { requirePassword } from '../lib/auth.js';
import { syncZoho } from '../lib/zoho.js';
import { safe, sendJson } from '../lib/http.js';

// Vercel Cron calls this with GET and "Authorization: Bearer <CRON_SECRET>".
// The dashboard's Run now button calls it with POST (no secret in the browser).
// A run tries a read-only Zoho sync first, then runs the rules. A failed or missing sync
// never blocks the run, and orders never change a flag. A run places no orders.
export default safe(async (req, res) => {
  let triggeredBy;
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
      return sendJson(res, 401, { error: 'Unauthorized.' });
    }
    triggeredBy = 'cron';
  } else if (req.method === 'POST') {
    if (!requirePassword(req, res)) return;
    triggeredBy = 'manual';
  } else {
    return sendJson(res, 405, { error: 'Use POST.' });
  }
  const out = await withPool(async (pool) => {
    // Cron delivery can occasionally fire twice. A second run would hide the decisions already
    // made on the first, so a scheduled run is skipped if a run happened in the last hour.
    if (triggeredBy === 'cron') {
      const last = await latestRun(pool);
      if (last && Date.now() - new Date(last.run_at).getTime() < 60 * 60 * 1000) {
        return { skipped: true, reason: 'A run already happened in the last hour.', run_id: last.id };
      }
    }
    let zoho;
    try {
      zoho = await syncZoho(pool);
    } catch {
      zoho = { state: 'failed', message: 'Zoho sync could not run.' };
    }
    const runId = await runRules(pool, triggeredBy);
    return { run_id: runId, triggered_by: triggeredBy, zoho };
  });
  sendJson(res, 200, out);
});
