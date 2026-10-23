import { withPool } from '../lib/db.js';
import { requirePassword } from '../lib/auth.js';
import {
  validateDistributorInput, listDistributorsFull, activeSkusByDistributor, createDistributor,
  updateDistributor, setDistributorActive, regionCounts, loadWatchInputs,
} from '../lib/distributors.js';
import { evaluateWatch, currentMonthIST } from '../lib/watch.js';
import { safe, sendJson, readJson } from '../lib/http.js';

// Deepa's Distributors tab: list, add, edit, deactivate, reactivate, and the "ordering less" watch.
// Distributors are never deleted. The watch reports a drop that already happened; it predicts and ranks nothing.
export default safe(async (req, res) => {
  if (!requirePassword(req, res)) return;
  if (req.method === 'GET') {
    const data = await withPool(async (pool) => {
      const distributors = await listDistributorsFull(pool);
      const watch = evaluateWatch({ distributors, ...(await loadWatchInputs(pool)), todayMonth: currentMonthIST() });
      return { distributors, regions: regionCounts(distributors), watch };
    });
    return sendJson(res, 200, data);
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use GET or POST.' });

  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { errors: ['The request is not valid JSON.'] });
  }
  const action = body && body.action;
  const out = await withPool(async (pool) => {
    const context = {
      existing: new Map((await listDistributorsFull(pool)).map((d) => [d.distributor_id, { active: d.active }])),
      activeSkusByDistributor: await activeSkusByDistributor(pool),
    };
    const checked = validateDistributorInput(body, action, context);
    if (checked.errors) return { status: 400, body: { ok: false, errors: checked.errors } };
    const v = checked.value;
    try {
      if (action === 'add') await createDistributor(pool, v);
      else if (action === 'edit') await updateDistributor(pool, v);
      else await setDistributorActive(pool, v.distributor_id, v.active);
    } catch (e) {
      if (e && e.code === '23505') return { status: 400, body: { ok: false, errors: [`Distributor ID ${v.distributor_id} already exists.`] } };
      throw e;
    }
    const notes = {
      add: 'Added. It can now be chosen on the SKUs page.',
      edit: 'Saved.',
      deactivate: 'Deactivated. It can no longer be chosen for SKUs, and the watch skips it.',
      reactivate: 'Reactivated.',
    };
    return { status: 200, body: { ok: true, distributor_id: v.distributor_id, note: notes[action] } };
  });
  sendJson(res, out.status, out.body);
});
