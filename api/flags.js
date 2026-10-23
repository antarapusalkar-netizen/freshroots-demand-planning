import { withPool } from '../lib/db.js';
import { latestRun, flagsForRun } from '../lib/store.js';
import { lastUpload } from '../lib/upload.js';
import { zohoState, openOrderLines, attachOrders } from '../lib/orders.js';
import { requirePassword } from '../lib/auth.js';
import { safe, sendJson } from '../lib/http.js';

// Latest run: header, active assumptions, flagged list, exceptions list. Sorted by SKU ID.
export default safe(async (req, res) => {
  if (!requirePassword(req, res)) return;
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Use GET.' });
  const body = await withPool(async (pool) => {
    const run = await latestRun(pool);
    if (!run) return { run: null };
    const rows = await flagsForRun(pool, run.id);
    const settings = (await pool.query('SELECT key, value::float8 AS value, description FROM rule_settings ORDER BY key')).rows;
    let flagged = rows.filter((r) => !r.is_exception && r.flag_types.length > 0);
    let exceptions = rows.filter((r) => r.is_exception);
    // On-order lines are shown only when the last Zoho sync worked. They never change a flag.
    const zoho = await zohoState(pool);
    let unmatched = null;
    if (zoho.state === 'ok') {
      const lines = await openOrderLines(pool);
      const a = attachOrders(flagged, lines);
      flagged = a.rows;
      exceptions = attachOrders(exceptions, lines).rows;
      unmatched = a.unmatched;
    }
    return {
      run,
      settings,
      skus_checked: rows.length,
      no_action_count: rows.length - flagged.length - exceptions.length,
      flagged,
      exceptions,
      zoho,
      unmatched,
      last_upload: await lastUpload(pool),
    };
  });
  sendJson(res, 200, body);
});
