# CLAUDE.md: Freshroots Demand Planning (Case 01)

Single source of truth for building this project in Claude Code. Build only what is written here. If something is missing or contradicts itself, stop and ask, don't guess.

## 1. What we are building

A small web app that applies Raghav Kulkarni's five documented forecasting rules to Freshroots' sales and stock data twice a week. It produces a **flagged-SKU list** and an **exceptions list**. Raghav reviews both on a review screen and approves or overrides each line. The approved list goes to the procurement team, who place the orders.

**The system informs. People decide.** The app never places an order, never makes the final call, and never ranks SKUs or people.

## 2. Case facts the build must respect

- Freshroots: FMCG distributor, Maharashtra and Goa. Budget ₹15 lakhs, 90 days, no AI team.
- Today's process: monthly, manual. Raghav spends about 2 working days pulling SAP data and running Excel, for 400 active SKUs across 1,200 distributors. Procurement sees data that is 3 to 4 weeks old.
- Cost of the problem: stockouts ₹18-22L per quarter, overstock write-offs ₹10-12L per quarter, so ₹28-34L per quarter in total.
- Raghav's rules govern about 80-85% of his recommendations. The other 15-20% (new launches, unusual distributor behaviour, one-off market events) stay with him as judgment.
- SAP exports structured files (IT team). Purchase orders live in Zoho Inventory, which the procurement team uses alongside SAP. The case does not confirm that Freshroots' Zoho plan allows API access, so the Zoho link needs credentials from the user before it can run live.

## 3. Scope

**Build (core, then layers)**
1. Load the five CSVs into Neon.
2. Rules engine that produces flags, recommended actions and quantities.
3. Exceptions list for anything the rules cannot handle.
4. Review screen where Raghav approves or overrides each line, plus an approved list for procurement.
5. Zoho Inventory **read-only** link: pull open purchase orders into Neon and show "already on order" next to each flag on the review screen.
6. OpenAI layer that writes a plain-language reason for each flag and exception (layer).
7. Twice-weekly Cron run and GitHub to Vercel deploy.

**Do not build**
- Automatic order placing, or writing anything to Zoho (create, update or delete). The Zoho link is read-only.
- Changing Raghav's rules to use on-order quantities. Open orders are shown for information only.
- Forecasting for new launches or one-off events (these go to the exceptions list).
- Ranking or scoring of SKUs, distributors or people. Sort by SKU ID and group by flag type.
- Distributor Service (WhatsApp) or Operations Intelligence. They failed the Nine Checks and are out of scope.
- Anything not listed above.

## 4. Stack

- **Code and deploy:** GitHub, Vercel (serverless functions in `/api`, static single-page HTML/CSS/JS front end).
- **Database:** Neon (Postgres).
- **Purchase orders:** Zoho Inventory REST API, read-only, OAuth 2.0, India data center. Check the official Zoho Inventory API docs for exact endpoints, scopes and field names before coding.
- **AI step:** OpenAI API (explanations only).
- **Schedule:** Vercel Cron.
- No Resend, no auth system, no extra frameworks. Keep dependencies minimal.

Environment variables (never commit values): `DATABASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `CRON_SECRET`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_ORG_ID`, `ZOHO_DC` (default `in`). The Zoho variables are optional: with none set, the app runs and says "Zoho not connected".

## 5. Data (seed files)

Prototype data is sample data: 15 SKUs, 16 weeks. The real case has 400 SKUs and 3 years, so the code must not hard-code these sizes.

| File | Columns | Notes |
|---|---|---|
| SKU | `SKU_ID, SKU_Name, Category, Perishability, Standard_Reorder_Qty, Unit_of_Measure, Distributor_ID` | `Perishability` is `High` or `Low` (3 High: SKU004, SKU007, SKU011) |
| Weekly Sales | `SKU_ID, Week, Units_Sold` | `Week` is ISO format like `2026-W27`; 16 weeks (W27 to W42) per SKU; per SKU only, not per distributor |
| Current Inventory | `SKU_ID, Location, Units_On_Hand, As_Of_Date` | One row per SKU, location `Pune Central Warehouse`, as of `2026-10-19` |
| Calendar | `Year, Month, Year_Month, Is_Festival_Month` | `TRUE`/`FALSE` as text; festival months are Mar, Oct, Nov |
| Distributor | `Distributor_ID, Distributor_Name, Region, Status` | 4 distributors; context only, the rules do not use it |

All five files join cleanly (every SKU and distributor ID matches). Validate on load and reject a file with missing columns or unknown SKU IDs, with a clear message.

## 6. Database tables

- `skus`, `sales_weekly`, `inventory`, `calendar`, `distributors`: mirror the CSVs.
- `rule_settings`: the thresholds as editable rows (see section 7), so Raghav can change them without code.
- `purchase_orders`: open purchase order lines pulled from Zoho: `zoho_po_id, po_number, status, item_ref, sku_id (nullable until matched), quantity, expected_date, synced_at`. Use only fields Zoho actually returns.
- `zoho_sync_log`: `id, synced_at, ok (bool), message, rows_pulled`.
- `runs`: `id, run_at, as_of_date, festival_month (bool), triggered_by (cron | manual)`.
- `flags`: `id, run_id, sku_id, flag_types (list), recommended_action, recommended_qty, rule_reason (text), ai_reason (text, nullable), is_exception (bool)`.
- `decisions`: `flag_id, decision (approved | overridden), override_qty (nullable), note (nullable), decided_at`.

## 7. The rules (exactly as Raghav documented them)

1. If an SKU's sales in the last 4 weeks are more than 20% above its 12-week average, flag **high-demand** and recommend a reorder at **1.5x** the standard quantity.
2. If current stock is below **6 weeks** of average weekly sales, flag **stockout risk** and recommend an immediate reorder.
3. If current stock exceeds **14 weeks** of average weekly sales, flag **overstock risk** and recommend pausing the next order.
4. Festival months (October, November, March) apply a **25% demand uplift before any threshold checks**.
5. High-perishability SKUs use tighter windows: **maximum 4 weeks** of stock, **minimum 3 weeks**.

### Assumptions the case does not settle (CONFIRM WITH USER BEFORE FINAL)

These are defaults so the build can start. Keep each one as a named setting so it is easy to change, and show the active assumptions on the review screen.

| # | Question | Default used |
|---|---|---|
| A1 | How do perishable windows relate to the 6 and 14 week thresholds? | For `Perishability = High`, the windows **replace** the general thresholds: stockout below 3 weeks, overstock above 4 weeks |
| A2 | Where does the 25% uplift apply? | It multiplies both the 12-week average and the last-4-week figure in festival months, before any check. Weeks of stock = stock / uplifted average |
| A3 | What is the 12-week average? | Mean of the last 12 weeks of sales, ending at the last full week, **including** the last 4 weeks |
| A4 | What if several rules fire on one SKU? | Record every flag. Stockout risk + high-demand together: reorder now at 1.5x. Overstock together with stockout or high-demand is a conflict and goes to the exceptions list |
| A5 | What is the "standard quantity"? | `Standard_Reorder_Qty` from the SKU file. Stockout risk recommends one standard quantity; overstock recommends 0 (pause) |
| A6 | Which month decides festival status? | The month of `As_Of_Date` from the inventory data, looked up in the Calendar file |
| A7 | How are Zoho order lines matched to our SKUs? | By the Zoho item's SKU code equal to `SKU_ID`. Lines that don't match go to a separate "unmatched orders" list. Never guess a match |

**Open purchase orders never change the rules.** Raghav's five rules do not mention stock on order, so flags and quantities are calculated exactly as above. On-order quantities are shown beside each flag so Raghav and procurement can see them.

### Exceptions list (rules cannot decide, so a human does)

An SKU goes to exceptions instead of getting a recommendation if any of these hold:
- Fewer than 12 weeks of sales history, or an average of zero.
- Missing stock or SKU data.
- Conflicting flags (see A4).

Each exception carries the reason it was routed there. New launches, unusual distributor behaviour and one-off events are not detected by the system. Raghav raises them himself.

## 8. Sanity check on the seed data (default assumptions A1-A6, festival month = October)

The rules engine must reproduce this. Use it as the first automated test.

| SKU | Flags |
|---|---|
| SKU001 | Stockout risk + high-demand (3.4 weeks of stock): reorder now at 1.5x |
| SKU003, SKU013 | Stockout risk: reorder now |
| SKU004, SKU011 | Stockout risk, perishable (1.8 weeks, below 3): reorder now |
| SKU006 | Overstock risk (22.2 weeks): pause next order |
| SKU007 | Overstock risk, perishable (4.1 weeks, above 4): pause next order |
| SKU002, 005, 008, 009, 010, 012, 014, 015 | No action |

If the assumptions change, update this table with the new expected results.

## 9. OpenAI layer (built after the Zoho link)

- Input: only the structured flag or exception record (SKU name, flag, the numbers used, the rule that fired).
- Output: one or two plain sentences explaining why it was flagged, for example "Stock covers 3.4 weeks against a 6-week minimum, and recent sales are well above average."
- **Never** change a flag, quantity or action, and never add numbers that were not in the input.
- If the call fails, show the rule's own `rule_reason` and carry on. The core must work with no AI.
- Keep the system prompt short and store it in one file.

## 10. Review screen (single page)

- Header: run date, as-of date, whether it is a festival month, and the active assumptions.
- Flagged list grouped by flag type, sorted by SKU ID. Columns: SKU, name, flag, recommended action, quantity, reason, **already on order** (units, expected date, PO number, status).
- Header also shows when Zoho was last synced. If Zoho is not connected or the last sync failed, show "Zoho not connected" or "Zoho sync failed", never a zero or an empty value that looks real.
- A small "unmatched Zoho orders" list for order lines that could not be matched to a SKU.
- Exceptions list with its reason.
- Per line: **Approve** or **Override** (with optional quantity and note). Nothing is final until a decision is saved.
- **Approved list** view for procurement, exportable as CSV. It shows only approved or overridden lines.
- A **Run now** button next to the Cron schedule.
- Clean, plain design: beige background, black text.

## 11. Triggers

- Vercel Cron calls the run endpoint twice a week. Put the schedule in `vercel.json` (Vercel Cron uses UTC). The endpoint must check `CRON_SECRET`.
- Manual **Run now** button uses the same endpoint.
- Each run first tries a Zoho sync, then runs the rules. A failed or missing sync never blocks the run.
- Prototype data loads with a seed script. A CSV upload endpoint for the IT team's SAP export is a later step.

## 12. Suggested file structure

```
/api
  run.js          # runs the rules, saves flags, calls the AI layer
  flags.js        # list flags for a run
  decide.js       # save approve / override
  approved.js     # approved list (+ CSV)
/lib
  rules.js        # the rules engine (pure functions, no I/O)
  zoho.js         # read-only Zoho Inventory client (token refresh, list open purchase orders)
  explain.js      # OpenAI layer
  db.js           # Neon connection
/scripts
  seed.js         # load and validate the five CSVs
/data             # the seed CSVs
/tests
  rules.test.js   # includes the section 8 table
  zoho.test.js    # uses mocked Zoho responses
index.html        # review screen
vercel.json
CLAUDE.md
```

Keep `rules.js` free of database and network code so it can be tested on its own.

## 13. Build order (core first, then layers)

Finish and confirm each step before starting the next.

1. **Schema + seed:** create the tables (except `purchase_orders` and `zoho_sync_log`, which come in step 4), load and validate the five CSVs. *Done when* row counts match (15 SKUs, 240 sales rows, 15 inventory rows, 24 calendar rows, 4 distributors).
2. **Rules engine:** `rules.js` with unit tests. *Done when* the section 8 table passes.
3. **API + review screen:** run, list flags, approve/override, approved list. *Done when* Raghav can review a run and export an approved list with no AI and no Cron.
4. **Zoho read-only link:** `lib/zoho.js`, the two tables, the matching rule (A7), and the extra review-screen column. *Done when* the app runs with no Zoho variables and shows "Zoho not connected", tests with mocked Zoho responses pass, and (only if the user supplies credentials) a live sync pulls real open purchase orders. Never invent purchase orders to make the screen look full.
5. **OpenAI layer:** reasons on each flag and exception, with the fallback. *Done when* turning the API key off still gives a working app.
6. **Cron + deploy:** push to GitHub, Vercel auto-deploys, schedule set. *Done when* the live URL runs on schedule and on **Run now**.

## 14. Rules for working in this repo

- Explain the plan before each step. Show proposed content (cell text, copy, prompts) before generating the final version.
- Do not invent data, columns, features or examples that are not in this file or the CSVs.
- Be open about trade-offs and any fix you make. If this file contradicts itself, say so and resolve it openly instead of quietly patching it.
- Keep it simple: no extra libraries or features beyond section 3.
- Never fabricate Zoho data, and never write to Zoho. Don't claim the Zoho link works unless a live call has actually succeeded.

## 15. Honest limits (state these in the final write-up)

- This is a prototype on sample data (15 SKUs, 16 weeks). It shows the logic working, but it cannot prove the ₹28-34L savings.
- There is no history of Raghav's past recommendations, so the planned check (rules matching his recommendations on roughly 80% of cases) cannot be run on this data. The kill criterion is applied by having Raghav review real output.
- The 15-20% judgment cases stay with Raghav by design.
- The seed data has no purchase orders and the case does not confirm Zoho API access. Unless the user supplies a Zoho account and credentials, the Zoho link is built and tested only with mocked responses, and the screen says "Zoho not connected".
