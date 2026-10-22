import { withPool } from '../lib/db.js';
import { latestRun, flagsForRun, approvedRows } from '../lib/store.js';
import { toCsv, APPROVED_COLUMNS } from '../lib/csv.js';
import { requirePassword } from '../lib/auth.js';
import { safe, sendJson, sendText } from '../lib/http.js';

// Approved and overridden lines of the latest run, for procurement. ?format=csv downloads a CSV.
export default safe(async (req, res) => {
  if (!requirePassword(req, res)) return;
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Use GET.' });
  const data = await withPool(async (pool) => {
    const run = await latestRun(pool);
    if (!run) return { run: null, rows: [] };
    const rows = approvedRows(await flagsForRun(pool, run.id), run.run_at.toISOString().slice(0, 10));
    return { run, rows };
  });
  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.get('format') === 'csv') {
    const name = data.run ? `approved-list-run-${data.run.id}.csv` : 'approved-list.csv';
    return sendText(res, 200, toCsv(data.rows, APPROVED_COLUMNS), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
    });
  }
  sendJson(res, 200, data);
});
