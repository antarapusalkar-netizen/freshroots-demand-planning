const REQUIRED = [
  'recent_weeks',
  'average_weeks',
  'high_demand_pct',
  'high_demand_multiplier',
  'stockout_weeks',
  'overstock_weeks',
  'festival_uplift_pct',
  'perishable_min_weeks',
  'perishable_max_weeks',
];

// Turns rule_settings rows into the plain object rules.js expects.
// A missing setting is an error: never fall back to a guessed value.
export function settingsFromRows(rows) {
  const settings = {};
  for (const r of rows) settings[r.key] = Number(r.value);
  const missing = REQUIRED.filter((k) => !Number.isFinite(settings[k]));
  if (missing.length) throw new Error(`rule_settings is missing: ${missing.join(', ')}`);
  return settings;
}

export async function loadSettings(pool) {
  const { rows } = await pool.query('SELECT key, value FROM rule_settings');
  return settingsFromRows(rows);
}
