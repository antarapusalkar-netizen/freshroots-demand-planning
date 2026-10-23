const AMOUNT_MAX = 1e11;

// Financial-year quarters, April to March. The year in the label is the year the financial year STARTS:
// 2026-Q1 = Apr-Jun 2026, Q2 = Jul-Sep 2026, Q3 = Oct-Dec 2026, Q4 = Jan-Mar 2027 (FY2026-27).
const RANGES = [['Apr', 'Jun', 0], ['Jul', 'Sep', 0], ['Oct', 'Dec', 0], ['Jan', 'Mar', 1]];
export function quarterRange(quarter) {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!m) return null;
  const year = Number(m[1]);
  const [from, to, nextYear] = RANGES[Number(m[2]) - 1];
  return {
    fy: `FY${year}-${String((year + 1) % 100).padStart(2, '0')}`,
    quarter_no: Number(m[2]),
    range: `${from}–${to} ${year + nextYear}`,
    label: `Q${m[2]} FY${year}-${String((year + 1) % 100).padStart(2, '0')} · ${from}–${to} ${year + nextYear}`,
  };
}

function amount(v, label, errors) {
  const s = String(v ?? '').replace(/[,\s₹]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    errors.push(`${label} must be a number in rupees, 0 or more, with at most 2 decimals.`);
    return null;
  }
  const n = Number(s);
  if (n > AMOUNT_MAX) { errors.push(`${label} is too large.`); return null; }
  return n;
}

// Only what Deepa types is stored. Re-entering a quarter replaces her earlier entry.
export function validateQuarter(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return { errors: ['Missing request body.'] };
  const quarter = typeof body.quarter === 'string' ? body.quarter.trim().toUpperCase() : '';
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!m || Number(m[1]) < 2000 || Number(m[1]) > 2100) errors.push('Quarter must look like 2026-Q3: the year the financial year starts in April, and Q1 to Q4 (Q3 = Oct–Dec).');
  const lost = amount(body.lost_sales_inr, 'Lost sales', errors);
  const writeoffs = amount(body.writeoffs_inr, 'Write-offs', errors);
  if (errors.length) return { errors };
  return { value: { quarter, lost_sales_inr: lost, writeoffs_inr: writeoffs } };
}

export async function saveQuarter(pool, v) {
  await pool.query(
    `INSERT INTO quarterly_results (quarter, lost_sales_inr, writeoffs_inr, entered_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (quarter) DO UPDATE SET lost_sales_inr = EXCLUDED.lost_sales_inr, writeoffs_inr = EXCLUDED.writeoffs_inr, entered_at = now()`,
    [v.quarter, v.lost_sales_inr, v.writeoffs_inr],
  );
}

export async function listQuarters(pool) {
  const { rows } = await pool.query(
    'SELECT quarter, lost_sales_inr::float8 AS lost_sales_inr, writeoffs_inr::float8 AS writeoffs_inr, entered_at FROM quarterly_results ORDER BY quarter DESC',
  );
  return rows;
}
