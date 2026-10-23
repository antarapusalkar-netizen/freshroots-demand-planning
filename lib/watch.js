// The "ordering less" watch (A10). Pure: no database, no clock. It reports a drop that already
// happened. It never predicts and never scores or ranks; results are sorted by name.

export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

// distributors: [{ distributor_id, distributor_name, region, active }]
// orders: [{ distributor_id, month: 'YYYY-MM', order_volume }]
// todayMonth: 'YYYY-MM', the month in progress. It is not a full month, so it is never used.
export function evaluateWatch({ distributors, orders, dropPct, baselineMonths, todayMonth }) {
  if (!orders.length) return { state: 'no_data' };
  const full = orders.map((o) => o.month).filter((m) => m < todayMonth);
  if (!full.length) return { state: 'no_full_month' };
  const latest = full.reduce((a, b) => (b > a ? b : a));
  const prevMonths = Array.from({ length: baselineMonths }, (_, i) => addMonths(latest, -(i + 1)));

  const volumes = new Map();
  for (const o of orders) {
    if (!volumes.has(o.distributor_id)) volumes.set(o.distributor_id, new Map());
    volumes.get(o.distributor_id).set(o.month, Number(o.order_volume));
  }

  const byName = (a, b) => a.distributor_name.localeCompare(b.distributor_name) || a.distributor_id.localeCompare(b.distributor_id);
  const fired = [];
  const notEvaluated = [];
  for (const d of distributors.filter((x) => x.active).sort(byName)) {
    const m = volumes.get(d.distributor_id) || new Map();
    const latestVol = m.get(latest);
    const prev = prevMonths.map((x) => m.get(x));
    const base = { distributor_id: d.distributor_id, distributor_name: d.distributor_name, region: d.region };
    // A missing month is not zero. It is not evaluated, and says so.
    if (latestVol === undefined || prev.some((v) => v === undefined)) {
      notEvaluated.push({ ...base, reason: `needs orders for ${latest} and the ${baselineMonths} months before it` });
      continue;
    }
    const sum = prev.reduce((a, b) => a + b, 0);
    if (sum <= 0) {
      notEvaluated.push({ ...base, reason: `no orders in the ${baselineMonths} months before ${latest}, so there is nothing to compare with` });
      continue;
    }
    // "30% or more below" the average, kept in whole numbers to avoid rounding errors.
    if (latestVol * 100 * baselineMonths <= sum * (100 - dropPct)) {
      const average = sum / baselineMonths;
      fired.push({ ...base, latest_month: latest, latest_volume: latestVol, previous_average: average, change_pct: (latestVol / average - 1) * 100 });
    }
  }
  return { state: 'ok', latest_month: latest, baseline_months: baselineMonths, drop_pct: dropPct, fired, not_evaluated: notEvaluated };
}

// The month in progress in India ('YYYY-MM'), so a part-month is never treated as a full one.
export function currentMonthIST(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}`;
}
