# CLAUDE.md: Freshroots Demand Planning (Case 01)

Single source of truth for building this project in Claude Code. Build only what is written here. If something is missing or contradicts itself, stop and ask, don't guess.

## 1. What we are building

A small web app that applies Raghav Kulkarni's five documented forecasting rules to Freshroots' sales and stock data twice a week. It produces a **flagged-SKU list** and an **exceptions list**. Raghav reviews both on a review screen and approves or overrides each line. The approved list goes to the procurement team, who place the orders.

**The system informs. People decide.** The app never places an order, never makes the final call, and never ranks SKUs or people.

### Who is who (from CLAUDE_ADDENDUM.md)

Deepa Nair (Head of Operations) is the project sponsor. She gets her own **read-only dashboard**. She does not approve flags. Raghav and the procurement team do.

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
8. SKU page on Raghav's dashboard (add, edit, deactivate, reactivate SKUs). *(addendum)*
9. Deepa's read-only dashboard (run history, review totals, quarterly numbers form). *(addendum)*
10. A Distributors tab on Deepa's dashboard (list, add, edit, deactivate, and an "ordering less" watch). *(addendum)*

**Do not build**
- Automatic order placing, or writing anything to Zoho (create, update or delete). The Zoho link is read-only.
- Changing Raghav's rules to use on-order quantities. Open orders are shown for information only.
- Forecasting for new launches or one-off events (these go to the exceptions list).
- Ranking or scoring of SKUs, distributors or people. Sort by SKU ID and group by flag type.
- Distributor Service (WhatsApp) or Operations Intelligence. They failed the Nine Checks and are out of scope.
- Predicting which distributors will leave. The watch only reports a drop that already happened. *(addendum)*
- Ranking or scoring of distributors. Sort distributors by name. *(addendum)*
- A login system (unless the user asks). The two dashboards are separate pages. *(addendum)*
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

Additions from CLAUDE_ADDENDUM.md:
- `skus` and `distributors` get an `active` flag (default true). Nothing is ever hard-deleted.
- `distributor_orders_monthly`: `distributor_id, month, order_volume`. The measure (units or value) comes from the SAP export. Ask before assuming. Empty until that file is loaded.
- `quarterly_results`: `quarter, lost_sales_inr, writeoffs_inr, entered_at`. Typed in by Deepa from her own records.

Tables and columns added during the build are listed in section 16.

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
| A8 | What happens to a newly added SKU? | It goes to the exceptions list until it has 12 weeks of sales (the existing exception rule). It gets no flag before that |
| A9 | What does "remove" mean for SKUs and distributors? | Deactivate, never delete. New runs skip inactive SKUs. A distributor with active SKUs cannot be deactivated until those SKUs are reassigned |
| A10 | When does the distributor watch fire? | When a distributor's latest full month of orders is 30% or more below the average of the previous 3 months. The 30% comes from the Nashik example in the case. Deepa confirms the number. It reports what happened and never predicts or scores |

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

## 10a. SKU page (on Raghav's dashboard) *(addendum)*

List all SKUs (active and inactive). Add or edit a SKU: ID, name, category, perishable or not, standard reorder quantity, unit, distributor. Deactivate or reactivate (A9). A new SKU follows A8.

## 10b. Deepa's dashboard (separate read-only page) *(addendum)*

The addendum names the page `deepa.html`. See section 16 for how pages are served in the repo. No approve or override buttons. She sees:
- **Run history:** date of each run, number of flags by type, number of exceptions.
- **Review activity:** how many lines were approved or overridden per run, and the time from run to decisions. Totals only. Never show or rank individual people.
- **Quarterly results:** a small form where she types the quarter's lost sales and write-offs (₹) from her own records, shown against the case baseline of ₹28-34L per quarter. Show only what she has typed, never a made-up figure.
- **Active rules and assumptions:** read-only.
- **Distributors tab:**
  - List all distributors (name, region, status), with a count per region.
  - Add, edit, deactivate or reactivate (A9). Fields: ID, name, region, status.
  - **Ordering-less watch (A10):** list distributors whose latest month is 30% or more below their previous 3-month average. Sort by name. No scores, no ranking. If `distributor_orders_monthly` is empty, show "No distributor-level order data loaded yet" and nothing else.
  - Reference text only: onboarding a new distributor costs about ₹1.5-2L and an average active distributor brings ₹18-25L a year (from the case). The tab never recommends adding or losing a distributor. That is Deepa's decision.

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

Current layout as built (the tree above is the original suggestion, kept for reference): `views/dashboard.html` replaces `index.html` and is served by `api/page.js` through a rewrite in `vercel.json`; only `public/` is served as static files. Extra files: `api/page.js`, `api/skus.js`, `api/upload.js`, `api/deepa.js`, `api/distributors.js`, `lib/skus.js`, `lib/watch.js`, `lib/distributors.js`, `lib/quarterly.js`, `lib/deepa.js`, `views/deepa.html`, `lib/auth.js`, `lib/csv.js`, `lib/decisions.js`, `lib/explain-prompt.js`, `lib/http.js`, `lib/orders.js`, `lib/settings.js`, `lib/sql.js`, `lib/upload.js`, `lib/validate.js`, `lib/zoho-config.js`, `scripts/dev.js`, `scripts/schema.sql`, `public/robots.txt`, and tests `api`, `auth`, `deepa`, `distributors`, `explain`, `rules`, `skus`, `upload`, `validate`, `watch`, `zoho`.

## 13. Build order (core first, then layers)

Finish and confirm each step before starting the next.

1. **Schema + seed:** create the tables (except `purchase_orders` and `zoho_sync_log`, which come in step 4), load and validate the five CSVs. *Done when* row counts match (15 SKUs, 240 sales rows, 15 inventory rows, 24 calendar rows, 4 distributors).
2. **Rules engine:** `rules.js` with unit tests. *Done when* the section 8 table passes.
3. **API + review screen:** run, list flags, approve/override, approved list. *Done when* Raghav can review a run and export an approved list with no AI and no Cron.
4. **Zoho read-only link:** `lib/zoho.js`, the two tables, the matching rule (A7), and the extra review-screen column. *Done when* the app runs with no Zoho variables and shows "Zoho not connected", tests with mocked Zoho responses pass, and (only if the user supplies credentials) a live sync pulls real open purchase orders. Never invent purchase orders to make the screen look full.
5. **OpenAI layer:** reasons on each flag and exception, with the fallback. *Done when* turning the API key off still gives a working app.
6. **Cron + deploy:** push to GitHub, Vercel auto-deploys, schedule set. *Done when* the live URL runs on schedule and on **Run now**.
7. **SKU page** *(addendum step A).* *Done when* Raghav can add a SKU (it lands in exceptions), edit it, deactivate it (the next run skips it) and reactivate it, with tests.
8. **Deepa's dashboard + Distributors tab** *(addendum step B).* *Done when* the page works on the sample data, shows "No distributor-level order data loaded yet" when that table is empty, and a test using clearly labelled test rows (never shown in the real screen) proves the 30% rule fires only when it should.

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
- The sample data has no distributor-level orders, so the watch can only be tested with labelled test rows until the real SAP export is loaded. *(addendum)*
- The quarterly results are only what Deepa types in. *(addendum)*
- Any login or access protection is the user's decision. State clearly what is and isn't protected. *(addendum)*

## 16. Added during the build (not in the original spec)

Recorded so this file matches the code. Each item was built at the user's request or as a safety measure, and any of them can be changed.

**Features**
- **SAP file upload:** an Upload tab (`api/upload.js`, `lib/upload.js`, table `data_uploads`). Weekly sales and/or current stock CSVs are validated; "Check" previews, "Load" saves. Sales are added or corrected by SKU and week. A stock file replaces the whole stock snapshot. Section 11 calls an upload "a later step".
- **Access codes:** `UPLOAD_PASSWORD` (required for the upload; with none set, uploads are refused). `SITE_PASSWORD` (optional shared password for the whole site; currently not set, so the site is open). A scheduled run (GET `/api/run`) needs `CRON_SECRET`. A manual run (POST) is open unless `SITE_PASSWORD` is set. Section 4 says "no auth system"; this is the exception.
- **Duplicate-cron guard:** a scheduled run is skipped if a run happened in the last 60 minutes, because Vercel can deliver a cron twice and a second run would hide decisions already made.
- **Page serving:** `api/page.js` serves `views/dashboard.html`; `vercel.json` rewrites `/` to it, sets `outputDirectory` to `public`, region `sin1`, and the cron `30 2 * * 1,4` (Monday and Thursday, 02:30 UTC, about 8:00 am IST).
- **OpenAI layer:** model `gpt-4.1-mini` (`OPENAI_MODEL`). One call per flagged or exception line, four at a time, 20 second timeout. An explanation containing a number not in the input record is discarded. The page shows the AI sentence with the rule's calculation underneath.
- **CSV handling:** line endings CRLF, LF and CR are all accepted, even mixed. The approved-list CSV prefixes cells that start with `=`, `+`, `-` or `@` so spreadsheets do not run them.

**Tables and columns added**
- `flags` also stores one row per SKU with no action (empty `flag_types`, not an exception), so counts stay honest.
- `purchase_orders` adds `line_item_id` (part of the key) and `quantity_received`.
- `runs.festival_month` can be empty when the stock month is not in the calendar.
- `app_settings` (editable text settings, currently `zoho_open_statuses`) and `data_uploads`.

**Assumptions not listed above**
- "On order" means a Zoho status of Issued or Partially_Received (setting `zoho_open_statuses`). The sync log records every status seen.
- If the stock month is not in the calendar, every SKU goes to exceptions.
- The as-of date is the latest `As_Of_Date` across inventory rows. The last 12 rows of sales are used without checking that the weeks are consecutive.
- A high-demand flag on its own recommends 1.5x the standard quantity, rounded to whole units.
- Environment variables added: `SITE_PASSWORD`, `UPLOAD_PASSWORD`.

**SKU page and Deepa's dashboard: how they were built (steps 7 and 8)**
- **Pages:** the SKU page is a tab on Raghav's dashboard. Deepa's page is `views/deepa.html`, served at `/deepa` through `api/page.js` (`vercel.json` rewrites `/deepa` to `/api/page?view=deepa`) instead of a root `deepa.html`. `/` and `/deepa` are separate pages. Both go through the same access check as everything else.
- **"Read-only" means no approvals.** Deepa's page has no approve, override, run, upload or SKU controls. It does let her type quarterly results and add, edit, deactivate and reactivate distributors, so it writes to those tables.
- **Deepa's link:** by the user's decision, the main page has a "Deepa's dashboard →" tab that redirects to her own page at `/deepa` (also reachable at `/deepa/` and `/deepa.html`), and her page links back to Raghav's. Her page is not embedded, so it can never show more than her read-only view. **There is no password on either page by the user's choice**, so anyone with the link can use Raghav's controls on the main page.
- **Distributors:** `status` stays as SAP's own text; `active` is the app's switch (A9). Deactivating a distributor with active SKUs is refused and the SKUs are named. SKUs can only be assigned to active distributors, and a SKU cannot be reactivated while its distributor is inactive.
- **Watch (A10) details:** settings `distributor_drop_pct` (30) and `distributor_baseline_months` (3) live in `app_settings`. "Latest full month" is the latest month in `distributor_orders_monthly` before the current month in India time, so a month in progress is never used. Only active distributors are checked. A missing month is never treated as zero: a distributor without orders for the latest month and the months before it is listed as "not evaluated". Results are sorted by name and carry no score.
- **`distributor_orders_monthly`** has no loader yet. The upload tab handles weekly sales and stock only. The table stays empty, and the watch shows "No distributor-level order data loaded yet". The measure (units or value) is whatever the SAP export uses; the watch only compares a distributor with its own earlier months.
- **Review activity:** per run, lines to review, approved, overridden, not decided, and hours from the run to the first and last saved decision. A later change to a decision moves the last time. Totals only; no person is named.
- **Quarterly results:** stored in rupees as typed. Quarters are **financial-year quarters, April to March**, labelled by the year the financial year starts: `2026-Q3` is Q3 of FY2026-27, Oct–Dec 2026, and `2026-Q4` is Jan–Mar 2027. The screen shows the date range next to every quarter. Entering the same quarter again replaces it.
- **Distributor orders upload:** a third file in the Upload tab, columns `Distributor_ID, Month, Order_Volume` (month `2026-09`, whole units per month; the case says "monthly order volume"). Added or corrected by distributor and month, never deleted by an upload. Tick "illustrative demo data" to label a demo file: those rows are tagged, Deepa's Distributors tab shows a clear "Illustrative demo data, not Freshroots data" banner, and "Remove illustrative orders" deletes only tagged rows. No demo data is loaded, and none should be invented. Uploading real data for the same month replaces the tagged row and its label.

## 17. Assumptions we would confirm with Raghav and Deepa

Raghav and Deepa are people in the case, so they cannot be asked. These are the defaults the build uses, why, and who we would confirm each with. "Editable" means a number in a settings row that is changed in the database (Neon console) with no code change or redeploy. There is no settings screen yet. How an assumption works (for example "replaces" or "before the checks") is code, and changing it means a code change and updating the section 8 table.

| # | Default used | Why | Confirm with | Editable without code |
|---|---|---|---|---|
| A1 | Perishable limits (3 and 4 weeks) **replace** the 6 and 14 week ones | Rule 5 gives tighter windows. Replacing is the reading where a perishable SKU can be understocked or overstocked without contradicting rules 2 and 3 | Raghav | The numbers: `perishable_min_weeks` 3, `perishable_max_weeks` 4. "Replace" is code |
| A2 | The 25% festival uplift applies to the 12-week average and the last-4-week figure **before** any check | Rule 4 says "before checking". Applying it to both leaves the high-demand ratio unchanged and only lowers weeks of stock | Raghav | The number: `festival_uplift_pct` 25, and the festival months in the `calendar` table. Where it applies is code |
| A3 | 12-week average = last 12 weeks of sales, including the last 4 | Rule 1 names both windows; including the last 4 is the plain reading | Raghav | `average_weeks` 12, `recent_weeks` 4 |
| A4 | Stockout + high demand: reorder at 1.5x. Overstock with either: goes to exceptions | The first two agree (order more). Overstock says pause, which contradicts them, so a person decides | Raghav | The 1.5: `high_demand_multiplier`. The routing is code |
| A5 | Standard quantity = `Standard_Reorder_Qty`: stockout 1x, overstock 0 | It is the only quantity in the data | Raghav, procurement | Per SKU on the SKUs page; the multipliers as above |
| A6 | The month of the stock date decides festival status | The stock date is the date the figures describe | Raghav | Festival months in the `calendar` table. The rule is code |
| A7 | Zoho lines match by item SKU code equal to `SKU_ID`; "on order" = Issued or Partially_Received | The only link that needs no guessing. Zoho's status list was not confirmed | Procurement | The statuses: `zoho_open_statuses` (text setting). Matching is code |
| A8 | A new SKU goes to exceptions until it has 12 weeks of sales | No history to judge; the existing exception rule already sends such SKUs to a person | Raghav | `average_weeks` 12 |
| A9 | SKUs and distributors are deactivated, never deleted; a distributor with active SKUs cannot be deactivated | Keeps history and past runs intact | Raghav, Deepa | Code |
| A10 | Watch fires when the latest full month is 30% or more below the previous 3-month average; a missing month is "not evaluated" | The 30% comes from the Nashik example in the case. Three months smooths one-off months. A missing month is not zero, so nothing is invented | Deepa | `distributor_drop_pct` 30, `distributor_baseline_months` 3 (text settings in `app_settings`). Missing-month handling is code |

Other defaults chosen on the user's decision: distributor orders are in **units**; quarters are **financial-year (April to March)**; access is open by choice, with a separate password on the upload.

**Statements for the write-up**
- Column names for all three uploads (sales, stock, distributor orders) are the sample file columns, to be confirmed with IT.
- Nothing records who approved or overrode a line. A decision stores only the time.
- Zoho is built read-only and tested with mocked responses. A live link needs the client's own Zoho account; Freshroots' Zoho is fictional. A Zoho trial with a few items and one open order would give live proof if wanted.
- The sample data has no distributor orders, so the watch stays empty. If a demo file is loaded for a presentation it must be uploaded with the illustrative label.
- The system never places an order and never writes to Zoho.

**Deliberately skipped:** draft purchase orders in Zoho, a run-history view on Raghav's page, per-person logins, and a separate Neon dev branch.
