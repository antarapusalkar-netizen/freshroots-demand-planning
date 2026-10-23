// Distributors: list, add, edit, deactivate, reactivate. Never deleted (A9).
// status is SAP's own text and is kept as typed; active is this app's on/off switch.
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

function text(v, label, max, errors) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) errors.push(`${label} is required.`);
  else if (s.length > max) errors.push(`${label} is too long (${max} characters at most).`);
  return s;
}

// context: { existing: Map id -> { active }, activeSkusByDistributor: Map id -> [sku ids] }
export function validateDistributorInput(body, action, { existing, activeSkusByDistributor }) {
  if (!body || typeof body !== 'object') return { errors: ['Missing request body.'] };
  if (!['add', 'edit', 'deactivate', 'reactivate'].includes(action)) return { errors: ['Unknown action.'] };
  const id = typeof body.distributor_id === 'string' ? body.distributor_id.trim() : '';
  if (!id) return { errors: ['Distributor ID is required.'] };
  const errors = [];

  if (action === 'add') {
    if (!ID_RE.test(id)) errors.push('Distributor ID may use letters, digits, - and _ only (32 characters at most).');
    else if ([...existing.keys()].some((k) => k.toUpperCase() === id.toUpperCase())) errors.push(`Distributor ID ${id} already exists.`);
  } else if (!existing.has(id)) {
    return { errors: [`No such distributor: ${id}.`] };
  }

  if (action === 'deactivate' || action === 'reactivate') {
    if (errors.length) return { errors };
    const wantActive = action === 'reactivate';
    if (existing.get(id).active === wantActive) return { errors: [`${id} is already ${wantActive ? 'active' : 'inactive'}.`] };
    if (!wantActive) {
      const skus = activeSkusByDistributor.get(id) || [];
      if (skus.length) {
        const shown = skus.slice(0, 10).join(', ') + (skus.length > 10 ? `, and ${skus.length - 10} more` : '');
        return { errors: [`${id} still has ${skus.length} active SKU${skus.length === 1 ? '' : 's'} (${shown}). Reassign them on the SKUs page first.`] };
      }
    }
    return { value: { distributor_id: id, active: wantActive } };
  }

  const distributor_name = text(body.distributor_name, 'Name', 120, errors);
  const region = text(body.region, 'Region', 60, errors);
  const status = text(body.status, 'Status', 30, errors);
  if (errors.length) return { errors };
  return { value: { distributor_id: id, distributor_name, region, status } };
}

export async function listDistributorsFull(pool) {
  const { rows } = await pool.query(
    `SELECT d.distributor_id, d.distributor_name, d.region, d.status, d.active,
            (SELECT count(*)::int FROM skus s WHERE s.distributor_id = d.distributor_id AND s.active) AS active_skus
       FROM distributors d ORDER BY d.distributor_name, d.distributor_id`,
  );
  return rows;
}

export async function activeSkusByDistributor(pool) {
  const { rows } = await pool.query('SELECT sku_id, distributor_id FROM skus WHERE active ORDER BY sku_id');
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.distributor_id)) map.set(r.distributor_id, []);
    map.get(r.distributor_id).push(r.sku_id);
  }
  return map;
}

export async function createDistributor(pool, v) {
  await pool.query(
    'INSERT INTO distributors (distributor_id, distributor_name, region, status, active) VALUES ($1, $2, $3, $4, true)',
    [v.distributor_id, v.distributor_name, v.region, v.status],
  );
}
export async function updateDistributor(pool, v) {
  await pool.query('UPDATE distributors SET distributor_name = $2, region = $3, status = $4 WHERE distributor_id = $1', [v.distributor_id, v.distributor_name, v.region, v.status]);
}
export async function setDistributorActive(pool, id, active) {
  await pool.query('UPDATE distributors SET active = $2 WHERE distributor_id = $1', [id, active]);
}

// Count per region, for the list header.
export function regionCounts(distributors) {
  const map = new Map();
  for (const d of distributors) {
    const r = map.get(d.region) || { region: d.region, total: 0, active: 0 };
    r.total += 1;
    if (d.active) r.active += 1;
    map.set(d.region, r);
  }
  return [...map.values()].sort((a, b) => a.region.localeCompare(b.region));
}

export async function loadWatchInputs(pool) {
  const rows = (await pool.query("SELECT key, value FROM app_settings WHERE key IN ('distributor_drop_pct', 'distributor_baseline_months')")).rows;
  const settings = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  if (!Number.isFinite(settings.distributor_drop_pct) || !Number.isFinite(settings.distributor_baseline_months)) {
    throw new Error('app_settings is missing the distributor watch settings');
  }
  const orders = (await pool.query('SELECT distributor_id, month, order_volume::float8 AS order_volume FROM distributor_orders_monthly')).rows;
  return { orders, dropPct: settings.distributor_drop_pct, baselineMonths: settings.distributor_baseline_months };
}

// How many order rows are loaded, and how many of them are labelled illustrative (demo, not Freshroots data).
export async function orderRowCounts(pool) {
  const { rows } = await pool.query('SELECT count(*)::int AS total, count(*) FILTER (WHERE illustrative)::int AS illustrative FROM distributor_orders_monthly');
  return rows[0];
}
