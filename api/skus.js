import { withPool } from '../lib/db.js';
import { requirePassword } from '../lib/auth.js';
import { validateSkuInput, listSkus, listDistributors, createSku, updateSku, setSkuActive } from '../lib/skus.js';
import { safe, sendJson, readJson } from '../lib/http.js';

// The SKU page: list, add, edit, deactivate, reactivate. Nothing is ever deleted.
// Changes apply from the next run; past runs keep showing what they showed.
export default safe(async (req, res) => {
  if (!requirePassword(req, res)) return;
  if (req.method === 'GET') {
    const data = await withPool(async (pool) => ({ skus: await listSkus(pool), distributors: await listDistributors(pool) }));
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
    const skus = await listSkus(pool);
    const context = {
      distributorIds: new Set((await listDistributors(pool)).map((d) => d.distributor_id)),
      existing: new Map(skus.map((s) => [s.sku_id, { active: s.active, distributor_id: s.distributor_id }])),
    };
    const checked = validateSkuInput(body, action, context);
    if (checked.errors) return { status: 400, body: { ok: false, errors: checked.errors } };
    const v = checked.value;
    try {
      if (action === 'add') await createSku(pool, v);
      else if (action === 'edit') await updateSku(pool, v);
      else await setSkuActive(pool, v.sku_id, v.active);
    } catch (e) {
      if (e && e.code === '23505') return { status: 400, body: { ok: false, errors: [`SKU ID ${v.sku_id} already exists.`] } };
      throw e;
    }
    const notes = {
      add: 'Added. It appears in the exceptions list on the next run until it has 12 weeks of sales. Press Run now to see it.',
      edit: 'Saved. It applies from the next run.',
      deactivate: 'Deactivated. The next run skips it. Its past runs are kept.',
      reactivate: 'Reactivated. The next run includes it again.',
    };
    return { status: 200, body: { ok: true, sku_id: v.sku_id, note: notes[action] } };
  });
  sendJson(res, out.status, out.body);
});
