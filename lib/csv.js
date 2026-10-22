// Text that starts with one of these can run as a formula when opened in Excel.
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value) {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'number' ? String(value) : String(value);
  if (typeof value === 'string' && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// columns: [{ header, key }]
export function toCsv(rows, columns) {
  const lines = [columns.map((c) => cell(c.header)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c.key])).join(','));
  return lines.join('\r\n') + '\r\n';
}

export const APPROVED_COLUMNS = [
  { header: 'Run_Date', key: 'run_date' },
  { header: 'SKU_ID', key: 'sku_id' },
  { header: 'SKU_Name', key: 'sku_name' },
  { header: 'Flags', key: 'flags' },
  { header: 'Recommended_Action', key: 'recommended_action' },
  { header: 'Recommended_Qty', key: 'recommended_qty' },
  { header: 'Decision', key: 'decision' },
  { header: 'Final_Qty', key: 'final_qty' },
  { header: 'Note', key: 'note' },
  { header: 'Decided_At', key: 'decided_at' },
];
