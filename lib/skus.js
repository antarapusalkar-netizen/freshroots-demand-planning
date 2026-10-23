// SKU page logic. Validation is pure; the database functions never delete a SKU (A9).
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

function text(v, label, max, errors) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) errors.push(`${label} is required.`);
  else if (s.length > max) errors.push(`${label} is too long (${max} characters at most).`);
  return s;
}

function parsePerishability(v) {
  if (v === true || v === 'true' || v === 'High') return 'High';
  if (v === false || v === 'false' || v === 'Low') return 'Low';
  return null;
}

// action: add | edit | deactivate | reactivate
// context: { distributorIds: Set of ACTIVE distributors, existing: Map of sku_id -> { active, distributor_id } }
// Returns { value } or { errors: [...] }.
export function validateSkuInput(body, action, { distributorIds, existing }) {
  const errors = [];
  if (!body || typeof body !== 'object') return { errors: ['Missing request body.'] };
  if (!['add', 'edit', 'deactivate', 'reactivate'].includes(action)) return { errors: ['Unknown action.'] };

  const id = typeof body.sku_id === 'string' ? body.sku_id.trim() : '';
  if (!id) return { errors: ['SKU ID is required.'] };

  if (action === 'add') {
    if (!ID_RE.test(id)) errors.push('SKU ID may use letters, digits, - and _ only (32 characters at most).');
    else if ([...existing.keys()].some((k) => k.toUpperCase() === id.toUpperCase())) errors.push(`SKU ID ${id} already exists.`);
  } else if (!existing.has(id)) {
    return { errors: [`No such SKU: ${id}.`] };
  }

  if (action === 'deactivate' || action === 'reactivate') {
    if (errors.length) return { errors };
    const wantActive = action === 'reactivate';
    if (existing.get(id).active === wantActive) return { errors: [`${id} is already ${wantActive ? 'active' : 'inactive'}.`] };
    if (wantActive && !distributorIds.has(existing.get(id).distributor_id)) {
      return { errors: [`${id}'s distributor is inactive. Edit the SKU to choose an active distributor first.`] };
    }
    return { value: { sku_id: id, active: wantActive } };
  }

  const sku_name = text(body.sku_name, 'Name', 120, errors);
  const category = text(body.category, 'Category', 60, errors);
  const unit_of_measure = text(body.unit_of_measure, 'Unit', 20, errors);
  const perishability = parsePerishability(body.perishable);
  if (!perishability) errors.push('Perishable must be yes or no.');
  const q = String(body.standard_reorder_qty ?? '').trim();
  const standard_reorder_qty = /^\d+$/.test(q) ? Number(q) : null;
  if (!standard_reorder_qty) errors.push('Standard reorder quantity must be a whole number above 0.');
  const distributor_id = typeof body.distributor_id === 'string' ? body.distributor_id.trim() : '';
  if (!distributorIds.has(distributor_id)) errors.push('Choose an active distributor.');

  if (errors.length) return { errors };
  return { value: { sku_id: id, sku_name, category, perishability, standard_reorder_qty, unit_of_measure, distributor_id } };
}

export async function listSkus(pool) {
  const { rows } = await pool.query(
    `SELECT s.sku_id, s.sku_name, s.category, s.perishability, s.standard_reorder_qty, s.unit_of_measure,
            s.distributor_id, d.distributor_name, s.active,
            (SELECT count(*)::int FROM sales_weekly w WHERE w.sku_id = s.sku_id) AS weeks_of_sales
       FROM skus s LEFT JOIN distributors d ON d.distributor_id = s.distributor_id
      ORDER BY s.sku_id`,
  );
  return rows;
}

export async function listDistributors(pool) {
  const { rows } = await pool.query('SELECT distributor_id, distributor_name FROM distributors WHERE active ORDER BY distributor_name');
  return rows;
}

export async function createSku(pool, v) {
  await pool.query(
    `INSERT INTO skus (sku_id, sku_name, category, perishability, standard_reorder_qty, unit_of_measure, distributor_id, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
    [v.sku_id, v.sku_name, v.category, v.perishability, v.standard_reorder_qty, v.unit_of_measure, v.distributor_id],
  );
}

export async function updateSku(pool, v) {
  await pool.query(
    `UPDATE skus SET sku_name = $2, category = $3, perishability = $4, standard_reorder_qty = $5,
                     unit_of_measure = $6, distributor_id = $7
      WHERE sku_id = $1`,
    [v.sku_id, v.sku_name, v.category, v.perishability, v.standard_reorder_qty, v.unit_of_measure, v.distributor_id],
  );
}

export async function setSkuActive(pool, id, active) {
  await pool.query('UPDATE skus SET active = $2 WHERE sku_id = $1', [id, active]);
}
