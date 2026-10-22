// Raghav's five rules as small pure functions. No database, no network.
// Assumptions A1-A6 (CLAUDE.md section 7) are named settings, passed in.

export const FLAG = {
  HIGH_DEMAND: 'high-demand',
  STOCKOUT: 'stockout-risk',
  OVERSTOCK: 'overstock-risk',
};

export const ACTION = {
  REORDER_NOW: 'reorder-now',
  PAUSE_ORDER: 'pause-order',
};

const round1 = (n) => Math.round(n * 10) / 10;

// units: weekly units sold, oldest first. Null if there are fewer than `weeks` entries.
export function averageWeekly(units, weeks) {
  if (units.length < weeks || weeks < 1) return null;
  const last = units.slice(-weeks);
  return last.reduce((a, b) => a + b, 0) / weeks;
}

// Rule 4: festival months add the uplift to demand before any check (A2).
export function applyFestivalUplift(demand, isFestival, upliftPct) {
  return isFestival ? (demand * (100 + upliftPct)) / 100 : demand;
}

export function weeksOfStock(unitsOnHand, avgWeekly) {
  return unitsOnHand / avgWeekly;
}

// Rule 1: recent sales more than pct% above the long average.
export function checkHighDemand(recentAvg, longAvg, highDemandPct) {
  return recentAvg * 100 > longAvg * (100 + highDemandPct);
}

// Rules 2 and 5: perishable SKUs use the tighter minimum (A1).
export function stockoutThreshold(isPerishable, settings) {
  return isPerishable ? settings.perishable_min_weeks : settings.stockout_weeks;
}
export function checkStockout(weeks, isPerishable, settings) {
  return weeks < stockoutThreshold(isPerishable, settings);
}

// Rules 3 and 5: perishable SKUs use the tighter maximum (A1).
export function overstockThreshold(isPerishable, settings) {
  return isPerishable ? settings.perishable_max_weeks : settings.overstock_weeks;
}
export function checkOverstock(weeks, isPerishable, settings) {
  return weeks > overstockThreshold(isPerishable, settings);
}

// Returns a reason string if the rules cannot decide this SKU, otherwise null.
// Conflicting flags are checked separately, after the flags are known.
export function checkExceptions({ sku, stock, units, festival }, settings) {
  if (!sku) return 'Missing SKU data.';
  if (!stock || stock.units_on_hand === null || stock.units_on_hand === undefined) {
    return 'Missing stock data.';
  }
  if (festival === null || festival === undefined) {
    return 'Festival status unknown: the as-of month is not in the calendar.';
  }
  if (units.length < settings.average_weeks) {
    return `Only ${units.length} weeks of sales history; ${settings.average_weeks} needed.`;
  }
  if (averageWeekly(units, settings.average_weeks) === 0) {
    return `Average weekly sales over the last ${settings.average_weeks} weeks is zero.`;
  }
  return null;
}

export function hasConflict(flags) {
  return flags.includes(FLAG.OVERSTOCK) && (flags.includes(FLAG.STOCKOUT) || flags.includes(FLAG.HIGH_DEMAND));
}

// Quantity and action from the flags (A4, A5). Call only when there is no conflict.
export function recommend(flags, standardQty, settings) {
  if (flags.includes(FLAG.OVERSTOCK)) return { action: ACTION.PAUSE_ORDER, qty: 0 };
  if (flags.includes(FLAG.HIGH_DEMAND)) {
    return { action: ACTION.REORDER_NOW, qty: Math.round(standardQty * settings.high_demand_multiplier) };
  }
  if (flags.includes(FLAG.STOCKOUT)) return { action: ACTION.REORDER_NOW, qty: standardQty };
  return { action: null, qty: null };
}

// One SKU in, one result out.
// input: { sku, stock, units, festival } where units are weekly sales oldest first.
export function evaluateSku(input, settings) {
  const { sku, stock, units, festival } = input;
  const base = {
    sku_id: sku ? sku.sku_id : null,
    flag_types: [],
    recommended_action: null,
    recommended_qty: null,
    is_exception: false,
    rule_reason: '',
  };

  const why = checkExceptions(input, settings);
  if (why) return { ...base, is_exception: true, rule_reason: why };

  const perishable = sku.perishability === 'High';
  const longAvg = applyFestivalUplift(averageWeekly(units, settings.average_weeks), festival, settings.festival_uplift_pct);
  const recentAvg = applyFestivalUplift(averageWeekly(units, settings.recent_weeks), festival, settings.festival_uplift_pct);
  const weeks = weeksOfStock(stock.units_on_hand, longAvg);

  const flags = [];
  if (checkHighDemand(recentAvg, longAvg, settings.high_demand_pct)) flags.push(FLAG.HIGH_DEMAND);
  if (checkStockout(weeks, perishable, settings)) flags.push(FLAG.STOCKOUT);
  if (checkOverstock(weeks, perishable, settings)) flags.push(FLAG.OVERSTOCK);

  const parts = [];
  const festNote = festival ? `, including the ${settings.festival_uplift_pct}% festival uplift` : '';
  if (flags.includes(FLAG.STOCKOUT)) {
    parts.push(`Stock of ${stock.units_on_hand} covers ${round1(weeks)} weeks of sales${festNote}, below the ${stockoutThreshold(perishable, settings)}-week minimum${perishable ? ' for perishable items' : ''}.`);
  }
  if (flags.includes(FLAG.OVERSTOCK)) {
    parts.push(`Stock of ${stock.units_on_hand} covers ${round1(weeks)} weeks of sales${festNote}, above the ${overstockThreshold(perishable, settings)}-week maximum${perishable ? ' for perishable items' : ''}.`);
  }
  if (flags.includes(FLAG.HIGH_DEMAND)) {
    const pct = Math.round((recentAvg / longAvg - 1) * 100);
    parts.push(`Sales over the last ${settings.recent_weeks} weeks average ${round1(recentAvg)} a week, ${pct}% above the ${settings.average_weeks}-week average of ${round1(longAvg)}, more than the ${settings.high_demand_pct}% threshold.`);
  }

  if (hasConflict(flags)) {
    return {
      ...base,
      flag_types: flags,
      is_exception: true,
      rule_reason: `Conflicting flags (${flags.join(' + ')}). ${parts.join(' ')}`,
    };
  }

  const { action, qty } = recommend(flags, sku.standard_reorder_qty, settings);
  return {
    ...base,
    flag_types: flags,
    recommended_action: action,
    recommended_qty: qty,
    rule_reason: parts.length ? parts.join(' ') : `No action: stock covers ${round1(weeks)} weeks of sales${festNote}, and recent demand is within ${settings.high_demand_pct}% of the average.`,
  };
}

// A6: festival status comes from the month of the as-of date, looked up in the calendar.
// Returns true, false, or null when that month is not in the calendar.
export function isFestivalMonth(asOfDate, calendar) {
  const [year, month] = String(asOfDate).slice(0, 10).split('-').map(Number);
  const row = calendar.find((c) => c.year === year && c.month === month);
  return row ? row.is_festival_month : null;
}

// All SKUs, sorted by SKU ID (no ranking). asOfDate is the latest date in the inventory rows.
export function evaluateAll({ skus, inventory, sales, calendar }, settings) {
  const dates = inventory.map((i) => String(i.as_of_date).slice(0, 10)).sort();
  const asOfDate = dates.length ? dates[dates.length - 1] : null;
  const festival = asOfDate ? isFestivalMonth(asOfDate, calendar) : null;

  const stockBySku = new Map(inventory.map((i) => [i.sku_id, i]));
  const unitsBySku = new Map();
  for (const s of [...sales].sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : 0))) {
    if (!unitsBySku.has(s.sku_id)) unitsBySku.set(s.sku_id, []);
    unitsBySku.get(s.sku_id).push(s.units_sold);
  }

  const results = [...skus]
    .sort((a, b) => (a.sku_id < b.sku_id ? -1 : a.sku_id > b.sku_id ? 1 : 0))
    .map((sku) =>
      evaluateSku({ sku, stock: stockBySku.get(sku.sku_id), units: unitsBySku.get(sku.sku_id) || [], festival }, settings),
    );
  return { asOfDate, festival, results };
}
