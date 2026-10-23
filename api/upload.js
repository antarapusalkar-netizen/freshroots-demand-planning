import { withPool } from '../lib/db.js';
import { requireUploadPassword } from '../lib/auth.js';
import { planUpload, applyUpload, loadPlanContext } from '../lib/upload.js';
import { safe, sendJson, readJson } from '../lib/http.js';

const MAX_CHARS = 4_000_000; // Vercel accepts request bodies up to about 4.5 MB

// Loads an SAP export (weekly sales and/or current stock) after checking it.
// mode "check" only reports what would happen. mode "load" writes it.
export default safe(async (req, res) => {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
  if (!requireUploadPassword(req, res)) return;
  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { errors: ['The request is not valid JSON.'] });
  }
  const mode = body && body.mode;
  if (mode !== 'check' && mode !== 'load') return sendJson(res, 400, { errors: ['mode must be "check" or "load".'] });
  const salesText = typeof body.sales === 'string' ? body.sales : '';
  const inventoryText = typeof body.inventory === 'string' ? body.inventory : '';
  if (salesText.length + inventoryText.length > MAX_CHARS) {
    return sendJson(res, 413, { errors: ['The files are too large for one upload (about 4 MB in total).'] });
  }
  const out = await withPool(async (pool) => {
    const plan = planUpload({ salesText, inventoryText }, await loadPlanContext(pool));
    if (plan.errors.length) return { status: 400, body: { ok: false, errors: plan.errors } };
    if (mode === 'load') await applyUpload(pool, plan);
    return { status: 200, body: { ok: true, loaded: mode === 'load', summary: plan.summary } };
  });
  sendJson(res, out.status, out.body);
});
