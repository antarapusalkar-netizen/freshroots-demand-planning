// What Deepa sees: run history and review totals. Totals only, never individual people.
const hours = (from, to) => (from && to ? Math.round(((new Date(to) - new Date(from)) / 3600000) * 10) / 10 : null);

export async function runOverview(pool, limit = 50) {
  const { rows } = await pool.query(
    `SELECT r.id, r.run_at, to_char(r.as_of_date, 'YYYY-MM-DD') AS as_of_date, r.triggered_by, r.festival_month,
            count(f.id) FILTER (WHERE f.is_exception OR cardinality(f.flag_types) > 0)::int AS lines_to_review,
            count(f.id) FILTER (WHERE 'high-demand' = ANY(f.flag_types))::int AS high_demand,
            count(f.id) FILTER (WHERE 'stockout-risk' = ANY(f.flag_types))::int AS stockout_risk,
            count(f.id) FILTER (WHERE 'overstock-risk' = ANY(f.flag_types))::int AS overstock_risk,
            count(f.id) FILTER (WHERE f.is_exception)::int AS exceptions,
            count(d.flag_id) FILTER (WHERE d.decision = 'approved')::int AS approved,
            count(d.flag_id) FILTER (WHERE d.decision = 'overridden')::int AS overridden,
            min(d.decided_at) AS first_decision, max(d.decided_at) AS last_decision
       FROM runs r
       LEFT JOIN flags f ON f.run_id = r.id
       LEFT JOIN decisions d ON d.flag_id = f.id
      GROUP BY r.id ORDER BY r.id DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id, run_at: r.run_at, as_of_date: r.as_of_date, triggered_by: r.triggered_by, festival_month: r.festival_month,
    flags_by_type: { high_demand: r.high_demand, stockout_risk: r.stockout_risk, overstock_risk: r.overstock_risk },
    exceptions: r.exceptions,
    lines_to_review: r.lines_to_review,
    approved: r.approved,
    overridden: r.overridden,
    not_decided: r.lines_to_review - r.approved - r.overridden,
    hours_to_first_decision: hours(r.run_at, r.first_decision),
    hours_to_last_decision: hours(r.run_at, r.last_decision),
  }));
}
