-- Step 1 tables. purchase_orders and zoho_sync_log are added in step 4.

CREATE TABLE IF NOT EXISTS distributors (
  distributor_id   text PRIMARY KEY,
  distributor_name text NOT NULL,
  region           text NOT NULL,
  status           text NOT NULL
);

CREATE TABLE IF NOT EXISTS skus (
  sku_id               text PRIMARY KEY,
  sku_name             text NOT NULL,
  category             text NOT NULL,
  perishability        text NOT NULL CHECK (perishability IN ('High', 'Low')),
  standard_reorder_qty integer NOT NULL CHECK (standard_reorder_qty > 0),
  unit_of_measure      text NOT NULL,
  distributor_id       text NOT NULL REFERENCES distributors (distributor_id)
);

CREATE TABLE IF NOT EXISTS sales_weekly (
  sku_id     text NOT NULL REFERENCES skus (sku_id),
  week       text NOT NULL CHECK (week ~ '^\d{4}-W\d{2}$'),
  units_sold integer NOT NULL CHECK (units_sold >= 0),
  PRIMARY KEY (sku_id, week)
);

CREATE TABLE IF NOT EXISTS inventory (
  sku_id        text PRIMARY KEY REFERENCES skus (sku_id),
  location      text NOT NULL,
  units_on_hand integer NOT NULL CHECK (units_on_hand >= 0),
  as_of_date    date NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar (
  year              integer NOT NULL,
  month             integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  year_month        text NOT NULL,
  is_festival_month boolean NOT NULL,
  PRIMARY KEY (year, month)
);

-- Thresholds as editable rows so Raghav can change them without code.
CREATE TABLE IF NOT EXISTS rule_settings (
  key         text PRIMARY KEY,
  value       numeric NOT NULL,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id             serial PRIMARY KEY,
  run_at         timestamptz NOT NULL DEFAULT now(),
  as_of_date     date,
  festival_month boolean,
  triggered_by   text NOT NULL CHECK (triggered_by IN ('cron', 'manual'))
);

CREATE TABLE IF NOT EXISTS flags (
  id                 serial PRIMARY KEY,
  run_id             integer NOT NULL REFERENCES runs (id),
  sku_id             text NOT NULL REFERENCES skus (sku_id),
  flag_types         text[] NOT NULL,
  recommended_action text,
  recommended_qty    integer,
  rule_reason        text NOT NULL,
  ai_reason          text,
  is_exception       boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS decisions (
  flag_id      integer PRIMARY KEY REFERENCES flags (id),
  decision     text NOT NULL CHECK (decision IN ('approved', 'overridden')),
  override_qty integer,
  note         text,
  decided_at   timestamptz NOT NULL DEFAULT now()
);

-- festival_month is unknown (null) when the as-of month is not in the calendar.
ALTER TABLE runs ALTER COLUMN festival_month DROP NOT NULL;

-- Step 4: open purchase orders pulled (read-only) from Zoho Inventory.
-- One row per purchase order line. sku_id is null until the Zoho item's SKU code matches a SKU_ID.
CREATE TABLE IF NOT EXISTS purchase_orders (
  zoho_po_id        text NOT NULL,
  line_item_id      text NOT NULL,
  po_number         text,
  status            text NOT NULL,
  item_ref          text,
  sku_id            text,
  quantity          numeric NOT NULL,
  quantity_received numeric,
  expected_date     date,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (zoho_po_id, line_item_id)
);

CREATE TABLE IF NOT EXISTS zoho_sync_log (
  id          serial PRIMARY KEY,
  synced_at   timestamptz NOT NULL DEFAULT now(),
  ok          boolean NOT NULL,
  message     text,
  rows_pulled integer
);

-- Small editable text settings. zoho_open_statuses: which Zoho statuses count as "on order".
CREATE TABLE IF NOT EXISTS app_settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  description text NOT NULL
);
INSERT INTO app_settings (key, value, description) VALUES
  ('zoho_open_statuses', 'issued,partially_received', 'Zoho purchase order statuses that count as already on order (comma separated)')
ON CONFLICT (key) DO NOTHING;
