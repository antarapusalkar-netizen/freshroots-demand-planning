import { parse } from 'csv-parse/sync';

// Pure functions: no database, no files. Each returns { rows, errors }.

const COLUMNS = {
  distributors: ['Distributor_ID', 'Distributor_Name', 'Region', 'Status'],
  skus: ['SKU_ID', 'SKU_Name', 'Category', 'Perishability', 'Standard_Reorder_Qty', 'Unit_of_Measure', 'Distributor_ID'],
  sales: ['SKU_ID', 'Week', 'Units_Sold'],
  inventory: ['SKU_ID', 'Location', 'Units_On_Hand', 'As_Of_Date'],
  calendar: ['Year', 'Month', 'Year_Month', 'Is_Festival_Month'],
};

export function parseCsv(text) {
  // Accept Windows (CRLF), Unix (LF) and old Mac (CR) line endings, even mixed in one file.
  return parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true, record_delimiter: ['\r\n', '\n', '\r'] });
}

function checkColumns(name, records) {
  const have = records.length ? Object.keys(records[0]) : [];
  const missing = COLUMNS[name].filter((c) => !have.includes(c));
  return missing.length ? [`${name}: missing column(s) ${missing.join(', ')}`] : [];
}

function nonNegInt(v) {
  return /^\d+$/.test(v) ? Number(v) : null;
}

function isRealDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function findDuplicates(label, keys, errors) {
  const seen = new Set();
  for (const k of keys) {
    if (seen.has(k)) errors.push(`${label}: duplicate ${k}`);
    seen.add(k);
  }
}

export function validateDistributors(records) {
  const errors = checkColumns('distributors', records);
  if (errors.length) return { rows: [], errors };
  records.forEach((r, i) => {
    for (const c of COLUMNS.distributors) {
      if (!r[c]) errors.push(`distributors row ${i + 2}: ${c} is empty`);
    }
  });
  findDuplicates('distributors', records.map((r) => r.Distributor_ID), errors);
  const rows = records.map((r) => ({
    distributor_id: r.Distributor_ID,
    distributor_name: r.Distributor_Name,
    region: r.Region,
    status: r.Status,
  }));
  return { rows, errors };
}

export function validateSkus(records, distributorIds) {
  const errors = checkColumns('skus', records);
  if (errors.length) return { rows: [], errors };
  const rows = [];
  records.forEach((r, i) => {
    const at = `skus row ${i + 2} (${r.SKU_ID || '?'})`;
    for (const c of ['SKU_ID', 'SKU_Name', 'Category', 'Unit_of_Measure']) {
      if (!r[c]) errors.push(`${at}: ${c} is empty`);
    }
    if (!['High', 'Low'].includes(r.Perishability)) {
      errors.push(`${at}: Perishability must be High or Low, got "${r.Perishability}"`);
    }
    const qty = nonNegInt(r.Standard_Reorder_Qty);
    if (qty === null || qty === 0) {
      errors.push(`${at}: Standard_Reorder_Qty must be a positive whole number, got "${r.Standard_Reorder_Qty}"`);
    }
    if (!distributorIds.has(r.Distributor_ID)) {
      errors.push(`${at}: unknown Distributor_ID "${r.Distributor_ID}"`);
    }
    rows.push({
      sku_id: r.SKU_ID,
      sku_name: r.SKU_Name,
      category: r.Category,
      perishability: r.Perishability,
      standard_reorder_qty: qty,
      unit_of_measure: r.Unit_of_Measure,
      distributor_id: r.Distributor_ID,
    });
  });
  findDuplicates('skus', records.map((r) => r.SKU_ID), errors);
  return { rows, errors };
}

export function validateSales(records, skuIds) {
  const errors = checkColumns('sales', records);
  if (errors.length) return { rows: [], errors };
  const rows = [];
  records.forEach((r, i) => {
    const at = `sales row ${i + 2}`;
    if (!skuIds.has(r.SKU_ID)) errors.push(`${at}: unknown SKU_ID "${r.SKU_ID}"`);
    const m = /^(\d{4})-W(\d{2})$/.exec(r.Week);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 53) {
      errors.push(`${at}: Week must look like 2026-W27, got "${r.Week}"`);
    }
    const units = nonNegInt(r.Units_Sold);
    if (units === null) errors.push(`${at}: Units_Sold must be a whole number, 0 or more, got "${r.Units_Sold}"`);
    rows.push({ sku_id: r.SKU_ID, week: r.Week, units_sold: units });
  });
  findDuplicates('sales', records.map((r) => `${r.SKU_ID}/${r.Week}`), errors);
  return { rows, errors };
}

export function validateInventory(records, skuIds) {
  const errors = checkColumns('inventory', records);
  if (errors.length) return { rows: [], errors };
  const rows = [];
  records.forEach((r, i) => {
    const at = `inventory row ${i + 2}`;
    if (!skuIds.has(r.SKU_ID)) errors.push(`${at}: unknown SKU_ID "${r.SKU_ID}"`);
    if (!r.Location) errors.push(`${at}: Location is empty`);
    const units = nonNegInt(r.Units_On_Hand);
    if (units === null) errors.push(`${at}: Units_On_Hand must be a whole number, 0 or more, got "${r.Units_On_Hand}"`);
    if (!isRealDate(r.As_Of_Date)) errors.push(`${at}: As_Of_Date must be a real date like 2026-10-19, got "${r.As_Of_Date}"`);
    rows.push({ sku_id: r.SKU_ID, location: r.Location, units_on_hand: units, as_of_date: r.As_Of_Date });
  });
  findDuplicates('inventory', records.map((r) => r.SKU_ID), errors);
  return { rows, errors };
}

export function validateCalendar(records) {
  const errors = checkColumns('calendar', records);
  if (errors.length) return { rows: [], errors };
  const rows = [];
  records.forEach((r, i) => {
    const at = `calendar row ${i + 2}`;
    const year = nonNegInt(r.Year);
    const month = nonNegInt(r.Month);
    if (year === null) errors.push(`${at}: Year must be a number, got "${r.Year}"`);
    if (month === null || month < 1 || month > 12) errors.push(`${at}: Month must be 1 to 12, got "${r.Month}"`);
    if (year !== null && month !== null) {
      const expected = `${year}-${String(month).padStart(2, '0')}`;
      if (r.Year_Month !== expected) errors.push(`${at}: Year_Month "${r.Year_Month}" does not match Year/Month (${expected})`);
    }
    if (!['TRUE', 'FALSE'].includes(r.Is_Festival_Month)) {
      errors.push(`${at}: Is_Festival_Month must be TRUE or FALSE, got "${r.Is_Festival_Month}"`);
    }
    rows.push({ year, month, year_month: r.Year_Month, is_festival_month: r.Is_Festival_Month === 'TRUE' });
  });
  findDuplicates('calendar', records.map((r) => r.Year_Month), errors);
  return { rows, errors };
}

// text: { distributors, skus, sales, inventory, calendar } of raw CSV strings.
export function validateAll(text) {
  const errors = [];
  const out = {};
  const run = (name, fn) => {
    let records;
    try {
      records = parseCsv(text[name]);
    } catch (e) {
      errors.push(`${name}: cannot read CSV (${e.message})`);
      return [];
    }
    const res = fn(records);
    errors.push(...res.errors);
    out[name] = res.rows;
    return res.rows;
  };
  const dist = run('distributors', validateDistributors);
  const skus = run('skus', (r) => validateSkus(r, new Set(dist.map((d) => d.distributor_id))));
  const skuIds = new Set(skus.map((s) => s.sku_id));
  run('sales', (r) => validateSales(r, skuIds));
  run('inventory', (r) => validateInventory(r, skuIds));
  run('calendar', validateCalendar);
  return { data: out, errors };
}
