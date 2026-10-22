# Easy build prompt: Freshroots Demand Planning

Paste this into Claude Code in your project folder. Put the five seed CSVs in a `/data` folder first. `CLAUDE.md` has the full detail, but this prompt is the short version and matches the simple component map.

```
Build the Freshroots Demand Planning web app. Work in five steps. Before each step, tell me your plan in a few lines. After each step, tell me what you built and tested, then STOP and wait for my OK.

THE IDEA
Freshroots plans its stock once a month by hand. This app checks every SKU twice a week using Raghav's five rules and flags what needs reordering. Raghav reviews the flags on a dashboard and approves or overrides each one. Procurement then places the orders. The system informs; people decide. It never places an order.

WHAT IS IN IT (same as my component map)
- SAP: IT sends sales and stock files (I have five sample CSVs in /data).
- Zoho Inventory: open purchase orders, READ ONLY. Never write to Zoho.
- Neon: the database that stores everything.
- Web app: the dashboard Raghav uses. It also runs the rules.
- Vercel: hosts the web app and sets an alarm (Cron) to run it twice a week. Code goes GitHub, then Vercel.

RAGHAV'S 5 RULES
1. Last 4 weeks of sales more than 20% above the 12-week average: flag "high demand", reorder 1.5 times the standard quantity.
2. Stock below 6 weeks of average sales: flag "stockout risk", reorder now.
3. Stock above 14 weeks of average sales: flag "overstock risk", pause the next order.
4. Festival months (Oct, Nov, Mar): add 25% to demand before checking.
5. Perishable items (Perishability = High): keep stock between 3 and 4 weeks.
Anything the rules can't decide (too little history, missing data, conflicting flags) goes to an "exceptions" list for Raghav.

THE FIVE STEPS
1. DATA: load the five CSVs into Neon and check they are valid. Expect 15 SKUs, 240 sales rows, 15 stock rows, 24 calendar rows, 4 distributors.
2. RULES: write the rules as simple, separate functions with tests. Test on the sample data (festival month = October). Expected: SKU001 stockout + high demand; SKU003, SKU013 stockout; SKU004, SKU011 stockout (perishable); SKU006 overstock; SKU007 overstock (perishable); the other 8 SKUs no action.
3. DASHBOARD: one page showing the flagged list and the exceptions list, with a reason on each line. Raghav can Approve or Override (optional quantity and note). Add an "approved list" for procurement that exports as CSV, and a "Run now" button. Sort by SKU ID. Don't rank anything.
4. ZOHO: pull open purchase orders into Neon and show "already on order" next to each flag. It must not change any flag. If there are no Zoho keys, the dashboard says "Zoho not connected". Never make up orders.
5. DEPLOY: push to GitHub, deploy on Vercel, and set the alarm to run twice a week. I will create the accounts and add keys myself.

RULES FOR YOU
- Don't invent data or add features that aren't here.
- Keep it simple. Use as few tools and libraries as you can.
- Keys and passwords go in .env only. Never print or commit them, and never ask me to paste them in chat.
- Don't say something works unless you actually tested it. Tell me what you could not test.
- Skip the OpenAI step in CLAUDE.md for now. If this prompt and CLAUDE.md disagree, ask me.

Start by reading CLAUDE.md and the CSV files. Then give me the plan for step 1 and wait.
```

## Before you paste it

- Put `CLAUDE.md` and the five CSVs (in `/data`) in the project folder.
- For step 4 you need your Zoho keys. Without them, the app still works and says "Zoho not connected".
- For step 5 you create the GitHub repo and the Vercel project yourself. Claude Code will tell you what to click.
