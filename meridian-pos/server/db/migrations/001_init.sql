-- Meridian POS — initial schema
-- Conventions
--   * All money is stored as INTEGER minor units (e.g. kobo, cents). Never REAL.
--   * Quantities are REAL (weighed goods), rounded to 3 dp by the application.
--   * IDs are TEXT, time-sortable, globally unique (safe for multi-terminal sync).
--   * Financial and history tables are append-only; triggers enforce it.
--   * Timestamps are ISO-8601 UTC strings.

PRAGMA foreign_keys = ON;

-- ───────────────────────── Tenancy: business → locations → registers ─────────
CREATE TABLE businesses (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  legal_name      TEXT,
  tax_id          TEXT,
  address         TEXT,
  phone           TEXT,
  email           TEXT,
  website         TEXT,
  currency        TEXT NOT NULL DEFAULT 'NGN' CHECK (length(currency) = 3),
  currency_minor  INTEGER NOT NULL DEFAULT 2 CHECK (currency_minor BETWEEN 0 AND 3),
  locale          TEXT NOT NULL DEFAULT 'en-NG',
  timezone        TEXT NOT NULL DEFAULT 'Africa/Lagos',
  logo_data       TEXT,
  prices_include_tax INTEGER NOT NULL DEFAULT 1 CHECK (prices_include_tax IN (0,1)),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE locations (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'store' CHECK (type IN ('store','warehouse')),
  address     TEXT,
  phone       TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at  TEXT NOT NULL,
  UNIQUE (business_id, code)
);

CREATE TABLE registers (
  id            TEXT PRIMARY KEY,
  location_id   TEXT NOT NULL REFERENCES locations(id),
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  next_sale_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_sale_seq > 0),
  created_at    TEXT NOT NULL,
  UNIQUE (location_id, code)
);

CREATE TABLE settings (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  key         TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT,
  PRIMARY KEY (business_id, key)
);

CREATE TABLE counters (
  business_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  value       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, name)
);

-- ───────────────────────── Identity & access ─────────────────────────────────
CREATE TABLE permissions (
  code        TEXT PRIMARY KEY,
  category    TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE roles (
  id               TEXT PRIMARY KEY,
  business_id      TEXT NOT NULL REFERENCES businesses(id),
  code             TEXT NOT NULL,
  name             TEXT NOT NULL,
  description      TEXT,
  max_discount_pct REAL NOT NULL DEFAULT 0 CHECK (max_discount_pct BETWEEN 0 AND 100),
  is_system        INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  UNIQUE (business_id, code)
);

CREATE TABLE role_permissions (
  role_id         TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code),
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE users (
  id                   TEXT PRIMARY KEY,
  business_id          TEXT NOT NULL REFERENCES businesses(id),
  username             TEXT NOT NULL COLLATE NOCASE,
  full_name            TEXT NOT NULL,
  email                TEXT,
  phone                TEXT,
  password_hash        TEXT NOT NULL,
  pin_hash             TEXT,
  role_id              TEXT NOT NULL REFERENCES roles(id),
  home_location_id     TEXT REFERENCES locations(id),
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at        TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (business_id, username)
);

CREATE TABLE auth_sessions (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      TEXT NOT NULL REFERENCES users(id),
  register_id  TEXT REFERENCES registers(id),
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  client       TEXT
);
CREATE INDEX ix_auth_sessions_user ON auth_sessions(user_id);

-- ───────────────────────── Catalogue ─────────────────────────────────────────
CREATE TABLE tax_rates (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  rate_bp     INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000), -- basis points: 750 = 7.5%
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  UNIQUE (business_id, code)
);

CREATE TABLE categories (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  name        TEXT NOT NULL,
  parent_id   TEXT REFERENCES categories(id),
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  UNIQUE (business_id, name)
);

CREATE TABLE suppliers (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  name         TEXT NOT NULL,
  contact_name TEXT,
  phone        TEXT,
  email        TEXT,
  address      TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);

CREATE TABLE products (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id),
  sku           TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  category_id   TEXT REFERENCES categories(id),
  brand         TEXT,
  unit          TEXT NOT NULL DEFAULT 'each' CHECK (unit IN ('each','kg','g','l','ml','pack','box','m')),
  is_weighed    INTEGER NOT NULL DEFAULT 0 CHECK (is_weighed IN (0,1)),
  plu           TEXT,
  price         INTEGER NOT NULL CHECK (price >= 0),
  cost          INTEGER NOT NULL DEFAULT 0 CHECK (cost >= 0),
  tax_rate_id   TEXT REFERENCES tax_rates(id),
  track_stock   INTEGER NOT NULL DEFAULT 1 CHECK (track_stock IN (0,1)),
  min_stock     REAL NOT NULL DEFAULT 0,
  reorder_qty   REAL NOT NULL DEFAULT 0,
  supplier_id   TEXT REFERENCES suppliers(id),
  allow_discount INTEGER NOT NULL DEFAULT 1 CHECK (allow_discount IN (0,1)),
  age_restricted INTEGER NOT NULL DEFAULT 0 CHECK (age_restricted IN (0,1)),
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (business_id, sku)
);
CREATE INDEX ix_products_name ON products(business_id, name);
CREATE INDEX ix_products_category ON products(category_id);
CREATE UNIQUE INDEX ux_products_plu ON products(business_id, plu) WHERE plu IS NOT NULL;

-- A product may have several barcodes (unit EAN, case/pack barcode with pack_qty).
CREATE TABLE product_barcodes (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  product_id  TEXT NOT NULL REFERENCES products(id),
  barcode     TEXT NOT NULL,
  pack_qty    REAL NOT NULL DEFAULT 1 CHECK (pack_qty > 0),
  is_primary  INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  created_at  TEXT NOT NULL,
  UNIQUE (business_id, barcode)
);
CREATE INDEX ix_barcodes_product ON product_barcodes(product_id);

-- ───────────────────────── Inventory ─────────────────────────────────────────
CREATE TABLE stock_levels (
  product_id  TEXT NOT NULL REFERENCES products(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  qty         REAL NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (product_id, location_id)
);

-- Every stock change is a movement. stock_levels.qty is the running sum.
CREATE TABLE inventory_movements (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id),
  product_id     TEXT NOT NULL REFERENCES products(id),
  location_id    TEXT NOT NULL REFERENCES locations(id),
  type           TEXT NOT NULL CHECK (type IN (
                   'opening','receive','sale','return','damage','adjustment',
                   'stocktake','transfer_out','transfer_in','void_reversal','expired','theft')),
  qty_change     REAL NOT NULL CHECK (qty_change <> 0),
  balance_after  REAL NOT NULL,
  unit_cost      INTEGER,
  reference_type TEXT,
  reference_id   TEXT,
  reason         TEXT,
  user_id        TEXT REFERENCES users(id),
  created_at     TEXT NOT NULL
);
CREATE INDEX ix_movements_product ON inventory_movements(product_id, location_id, created_at);
CREATE INDEX ix_movements_ref ON inventory_movements(reference_type, reference_id);
CREATE INDEX ix_movements_created ON inventory_movements(business_id, created_at);

CREATE TABLE goods_receipts (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  number      TEXT NOT NULL UNIQUE,
  location_id TEXT NOT NULL REFERENCES locations(id),
  supplier_id TEXT REFERENCES suppliers(id),
  supplier_ref TEXT,
  total_cost  INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  received_by TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE TABLE goods_receipt_items (
  id         TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES goods_receipts(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  qty        REAL NOT NULL CHECK (qty > 0),
  unit_cost  INTEGER NOT NULL CHECK (unit_cost >= 0)
);

CREATE TABLE stock_transfers (
  id               TEXT PRIMARY KEY,
  business_id      TEXT NOT NULL REFERENCES businesses(id),
  number           TEXT NOT NULL UNIQUE,
  from_location_id TEXT NOT NULL REFERENCES locations(id),
  to_location_id   TEXT NOT NULL REFERENCES locations(id),
  status           TEXT NOT NULL CHECK (status IN ('completed','cancelled')),
  note             TEXT,
  created_by       TEXT NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL,
  CHECK (from_location_id <> to_location_id)
);
CREATE TABLE stock_transfer_items (
  id          TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL REFERENCES stock_transfers(id),
  product_id  TEXT NOT NULL REFERENCES products(id),
  qty         REAL NOT NULL CHECK (qty > 0)
);

-- ───────────────────────── Customers ─────────────────────────────────────────
CREATE TABLE customers (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id),
  code           TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  phone          TEXT,
  email          TEXT,
  address        TEXT,
  notes          TEXT,
  loyalty_points INTEGER NOT NULL DEFAULT 0,
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (business_id, code)
);
CREATE UNIQUE INDEX ux_customers_phone ON customers(business_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX ix_customers_name ON customers(business_id, full_name);

-- ───────────────────────── Payment configuration ─────────────────────────────
CREATE TABLE payment_methods (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id),
  code              TEXT NOT NULL,
  name              TEXT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('cash','card','bank_transfer','mobile_money','wallet','other')),
  provider_code     TEXT NOT NULL,             -- adapter that processes it: 'cash', 'manual', 'sim-card', ...
  is_active         INTEGER NOT NULL DEFAULT 1,
  allow_offline     INTEGER NOT NULL DEFAULT 0, -- only locally-confirmed methods may be 1
  allow_change      INTEGER NOT NULL DEFAULT 0, -- only cash
  requires_reference INTEGER NOT NULL DEFAULT 0,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  shortcut          TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE (business_id, code)
);

CREATE TABLE provider_configs (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id),
  provider_code TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  config_json   TEXT NOT NULL DEFAULT '{}',    -- non-secret settings only
  secret_ref    TEXT,                          -- pointer into the encrypted secret store; never the secret
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (business_id, provider_code)
);

-- ───────────────────────── Cashier sessions & cash ───────────────────────────
CREATE TABLE register_sessions (
  id               TEXT PRIMARY KEY,
  business_id      TEXT NOT NULL REFERENCES businesses(id),
  number           TEXT NOT NULL UNIQUE,
  register_id      TEXT NOT NULL REFERENCES registers(id),
  location_id      TEXT NOT NULL REFERENCES locations(id),
  user_id          TEXT NOT NULL REFERENCES users(id),
  status           TEXT NOT NULL CHECK (status IN ('open','closed')),
  opening_float    INTEGER NOT NULL CHECK (opening_float >= 0),
  opened_at        TEXT NOT NULL,
  closed_at        TEXT,
  closed_by        TEXT REFERENCES users(id),
  expected_cash    INTEGER,
  counted_cash     INTEGER,
  variance         INTEGER,
  count_detail_json TEXT,
  close_note       TEXT,
  review_status    TEXT NOT NULL DEFAULT 'none' CHECK (review_status IN ('none','required','approved')),
  reviewed_by      TEXT REFERENCES users(id),
  reviewed_at      TEXT,
  review_note      TEXT
);
CREATE UNIQUE INDEX ux_one_open_session_per_register ON register_sessions(register_id) WHERE status = 'open';
CREATE INDEX ix_sessions_opened ON register_sessions(business_id, opened_at);

-- Non-sale cash movements through the drawer.
CREATE TABLE cash_movements (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES register_sessions(id),
  type          TEXT NOT NULL CHECK (type IN ('paid_in','paid_out','cash_drop')),
  amount        INTEGER NOT NULL CHECK (amount > 0),
  reason        TEXT NOT NULL,
  reference     TEXT,
  user_id       TEXT NOT NULL REFERENCES users(id),
  authorized_by TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX ix_cash_movements_session ON cash_movements(session_id);

-- ───────────────────────── Sales ─────────────────────────────────────────────
CREATE TABLE sales (
  id                    TEXT PRIMARY KEY,
  business_id           TEXT NOT NULL REFERENCES businesses(id),
  number                TEXT NOT NULL UNIQUE,
  location_id           TEXT NOT NULL REFERENCES locations(id),
  register_id           TEXT NOT NULL REFERENCES registers(id),
  session_id            TEXT NOT NULL REFERENCES register_sessions(id),
  cashier_id            TEXT NOT NULL REFERENCES users(id),
  customer_id           TEXT REFERENCES customers(id),
  status                TEXT NOT NULL CHECK (status IN ('open','held','completed','cancelled','voided')),
  currency              TEXT NOT NULL,
  prices_include_tax    INTEGER NOT NULL,
  subtotal              INTEGER NOT NULL DEFAULT 0,
  discount_total        INTEGER NOT NULL DEFAULT 0,
  tax_total             INTEGER NOT NULL DEFAULT 0,
  total                 INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  amount_paid           INTEGER NOT NULL DEFAULT 0,
  change_given          INTEGER NOT NULL DEFAULT 0,
  cart_discount_type    TEXT CHECK (cart_discount_type IN ('percent','amount')),
  cart_discount_value   REAL,
  cart_discount_reason  TEXT,
  cart_discount_by      TEXT REFERENCES users(id),
  hold_label            TEXT,
  note                  TEXT,
  loyalty_points_earned INTEGER NOT NULL DEFAULT 0,
  completed_offline     INTEGER NOT NULL DEFAULT 0,
  receipt_print_count   INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  completed_at          TEXT,
  cancelled_at          TEXT,
  cancel_reason         TEXT,
  voided_at             TEXT,
  voided_by             TEXT REFERENCES users(id),
  void_reason           TEXT
);
CREATE INDEX ix_sales_status ON sales(business_id, status);
CREATE INDEX ix_sales_completed ON sales(business_id, completed_at);
CREATE INDEX ix_sales_session ON sales(session_id);
CREATE INDEX ix_sales_customer ON sales(customer_id);
CREATE INDEX ix_sales_register_open ON sales(register_id, status);

CREATE TABLE sale_items (
  id                  TEXT PRIMARY KEY,
  sale_id             TEXT NOT NULL REFERENCES sales(id),
  line_no             INTEGER NOT NULL,
  product_id          TEXT NOT NULL REFERENCES products(id),
  sku                 TEXT NOT NULL,
  name                TEXT NOT NULL,
  unit                TEXT NOT NULL,
  barcode             TEXT,
  qty                 REAL NOT NULL CHECK (qty > 0),
  unit_price          INTEGER NOT NULL CHECK (unit_price >= 0),
  list_price          INTEGER NOT NULL CHECK (list_price >= 0),
  price_override_by   TEXT REFERENCES users(id),
  unit_cost           INTEGER NOT NULL DEFAULT 0,
  line_discount_type  TEXT CHECK (line_discount_type IN ('percent','amount')),
  line_discount_value REAL,
  line_discount_reason TEXT,
  line_discount_by    TEXT REFERENCES users(id),
  gross               INTEGER NOT NULL DEFAULT 0,  -- qty × unit_price
  line_discount       INTEGER NOT NULL DEFAULT 0,
  cart_discount_alloc INTEGER NOT NULL DEFAULT 0,
  tax_rate_bp         INTEGER NOT NULL DEFAULT 0,
  tax_amount          INTEGER NOT NULL DEFAULT 0,
  line_total          INTEGER NOT NULL DEFAULT 0,  -- what the customer pays for the line
  created_at          TEXT NOT NULL,
  UNIQUE (sale_id, line_no)
);
CREATE INDEX ix_sale_items_product ON sale_items(product_id);

-- ───────────────────────── Payments ──────────────────────────────────────────
CREATE TABLE payments (
  id                  TEXT PRIMARY KEY,
  business_id         TEXT NOT NULL REFERENCES businesses(id),
  sale_id             TEXT NOT NULL REFERENCES sales(id),
  session_id          TEXT NOT NULL REFERENCES register_sessions(id),
  method_code         TEXT NOT NULL,
  method_type         TEXT NOT NULL,
  provider_code       TEXT NOT NULL,
  amount              INTEGER NOT NULL CHECK (amount > 0), -- applied to the sale
  tendered            INTEGER,                            -- cash handed over
  change_given        INTEGER NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending','processing','succeeded','failed','cancelled','voided')),
  idempotency_key     TEXT NOT NULL UNIQUE,
  provider_ref        TEXT,
  provider_status     TEXT,
  confirmation_source TEXT CHECK (confirmation_source IN ('provider','manual','local')),
  reference           TEXT,
  failure_reason      TEXT,
  instructions_json   TEXT,
  metadata_json       TEXT,
  created_offline     INTEGER NOT NULL DEFAULT 0,
  created_by          TEXT NOT NULL REFERENCES users(id),
  confirmed_by        TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  confirmed_at        TEXT,
  next_check_at       TEXT
);
CREATE INDEX ix_payments_sale ON payments(sale_id);
CREATE INDEX ix_payments_status ON payments(business_id, status);
CREATE INDEX ix_payments_provider_ref ON payments(provider_code, provider_ref);
CREATE INDEX ix_payments_confirmed ON payments(business_id, confirmed_at);
-- At most one in-flight payment per sale: prevents double-charging from double clicks.
CREATE UNIQUE INDEX ux_one_inflight_payment ON payments(sale_id) WHERE status IN ('pending','processing');

-- Append-only log of every conversation with a provider.
CREATE TABLE payment_attempts (
  id                TEXT PRIMARY KEY,
  payment_id        TEXT REFERENCES payments(id),
  refund_payment_id TEXT,
  provider_code     TEXT NOT NULL,
  action            TEXT NOT NULL CHECK (action IN ('initiate','status','cancel','refund','refund_status','webhook','manual_confirm')),
  outcome           TEXT NOT NULL,
  request_json      TEXT,
  response_json     TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX ix_attempts_payment ON payment_attempts(payment_id);

CREATE TABLE webhook_events (
  id             TEXT PRIMARY KEY,
  provider_code  TEXT NOT NULL,
  event_id       TEXT NOT NULL,
  signature_ok   INTEGER NOT NULL,
  payload_json   TEXT NOT NULL,
  processed      INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  received_at    TEXT NOT NULL,
  UNIQUE (provider_code, event_id)
);

-- ───────────────────────── Refunds & voids ───────────────────────────────────
CREATE TABLE refunds (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id),
  number        TEXT NOT NULL UNIQUE,
  sale_id       TEXT NOT NULL REFERENCES sales(id),
  kind          TEXT NOT NULL CHECK (kind IN ('refund','void')),
  status        TEXT NOT NULL CHECK (status IN ('pending','completed','failed')),
  reason_code   TEXT NOT NULL,
  reason_note   TEXT,
  subtotal      INTEGER NOT NULL,
  tax_total     INTEGER NOT NULL,
  total         INTEGER NOT NULL CHECK (total >= 0),
  location_id   TEXT NOT NULL REFERENCES locations(id),
  register_id   TEXT REFERENCES registers(id),
  session_id    TEXT REFERENCES register_sessions(id),
  requested_by  TEXT NOT NULL REFERENCES users(id),
  authorized_by TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  completed_at  TEXT
);
CREATE INDEX ix_refunds_sale ON refunds(sale_id);
CREATE INDEX ix_refunds_created ON refunds(business_id, created_at);

CREATE TABLE refund_items (
  id           TEXT PRIMARY KEY,
  refund_id    TEXT NOT NULL REFERENCES refunds(id),
  sale_item_id TEXT NOT NULL REFERENCES sale_items(id),
  product_id   TEXT NOT NULL REFERENCES products(id),
  qty          REAL NOT NULL CHECK (qty > 0),
  amount       INTEGER NOT NULL CHECK (amount >= 0),
  tax_amount   INTEGER NOT NULL DEFAULT 0,
  condition    TEXT NOT NULL CHECK (condition IN ('resaleable','damaged','not_returned'))
);
CREATE INDEX ix_refund_items_sale_item ON refund_items(sale_item_id);

CREATE TABLE refund_payments (
  id                  TEXT PRIMARY KEY,
  refund_id           TEXT NOT NULL REFERENCES refunds(id),
  original_payment_id TEXT REFERENCES payments(id),
  session_id          TEXT REFERENCES register_sessions(id),
  method_code         TEXT NOT NULL,
  method_type         TEXT NOT NULL,
  provider_code       TEXT NOT NULL,
  amount              INTEGER NOT NULL CHECK (amount > 0),
  status              TEXT NOT NULL CHECK (status IN ('pending','processing','succeeded','failed')),
  provider_ref        TEXT,
  confirmation_source TEXT CHECK (confirmation_source IN ('provider','manual','local')),
  reference           TEXT,
  failure_reason      TEXT,
  idempotency_key     TEXT NOT NULL UNIQUE,
  created_at          TEXT NOT NULL,
  confirmed_at        TEXT
);
CREATE INDEX ix_refund_payments_refund ON refund_payments(refund_id);
CREATE INDEX ix_refund_payments_orig ON refund_payments(original_payment_id);

-- ───────────────────────── Settlements, payouts, reconciliation ──────────────
CREATE TABLE financial_accounts (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id),
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('cash_safe','bank','provider_balance','other')),
  provider_code TEXT,
  location_id   TEXT REFERENCES locations(id),
  bank_name     TEXT,
  account_mask  TEXT,          -- last 4 digits only; never full account numbers
  currency      TEXT NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  UNIQUE (business_id, code)
);

-- A provider settlement batch: money the provider says it moved to the business.
CREATE TABLE settlements (
  id                      TEXT PRIMARY KEY,
  business_id             TEXT NOT NULL REFERENCES businesses(id),
  provider_code           TEXT NOT NULL,
  provider_settlement_ref TEXT NOT NULL,
  settlement_date         TEXT NOT NULL,
  period_start            TEXT NOT NULL,
  period_end              TEXT NOT NULL,
  currency                TEXT NOT NULL,
  gross_amount            INTEGER NOT NULL,
  refund_amount           INTEGER NOT NULL DEFAULT 0,
  fee_amount              INTEGER NOT NULL DEFAULT 0,
  adjustment_amount       INTEGER NOT NULL DEFAULT 0,
  net_amount              INTEGER NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('reported','matched','discrepancy','resolved')),
  destination_account_id  TEXT REFERENCES financial_accounts(id),
  source                  TEXT NOT NULL CHECK (source IN ('provider_api','manual','csv')),
  match_summary_json      TEXT,
  created_by              TEXT REFERENCES users(id),
  created_at              TEXT NOT NULL,
  CHECK (net_amount = gross_amount - refund_amount - fee_amount + adjustment_amount),
  UNIQUE (provider_code, provider_settlement_ref)
);

CREATE TABLE settlement_items (
  id                TEXT PRIMARY KEY,
  settlement_id     TEXT NOT NULL REFERENCES settlements(id),
  type              TEXT NOT NULL CHECK (type IN ('payment','refund','fee','adjustment')),
  provider_ref      TEXT,
  amount            INTEGER NOT NULL,
  fee               INTEGER NOT NULL DEFAULT 0,
  payment_id        TEXT REFERENCES payments(id),
  refund_payment_id TEXT REFERENCES refund_payments(id),
  match_status      TEXT NOT NULL CHECK (match_status IN ('matched','amount_mismatch','unknown_reference','not_applicable'))
);
CREATE INDEX ix_settlement_items_settlement ON settlement_items(settlement_id);
CREATE INDEX ix_settlement_items_payment ON settlement_items(payment_id);

-- Money leaving the business / moving between business accounts. Distinct from customer payments and refunds.
CREATE TABLE payouts (
  id                     TEXT PRIMARY KEY,
  business_id            TEXT NOT NULL REFERENCES businesses(id),
  number                 TEXT NOT NULL UNIQUE,
  type                   TEXT NOT NULL CHECK (type IN ('provider_payout','bank_deposit','cash_withdrawal','supplier_payment','refund_payout','owner_drawing','other')),
  amount                 INTEGER NOT NULL CHECK (amount > 0),
  currency               TEXT NOT NULL,
  source_account_id      TEXT REFERENCES financial_accounts(id),
  destination_account_id TEXT REFERENCES financial_accounts(id),
  destination_note       TEXT,
  settlement_id          TEXT REFERENCES settlements(id),
  session_id             TEXT REFERENCES register_sessions(id),
  status                 TEXT NOT NULL CHECK (status IN ('pending_approval','approved','paid','rejected','cancelled')),
  reason                 TEXT NOT NULL,
  reference              TEXT,
  requested_by           TEXT NOT NULL REFERENCES users(id),
  approved_by            TEXT REFERENCES users(id),
  rejected_by            TEXT REFERENCES users(id),
  paid_by                TEXT REFERENCES users(id),
  rejection_reason       TEXT,
  created_at             TEXT NOT NULL,
  approved_at            TEXT,
  paid_at                TEXT,
  -- segregation of duties: nobody approves their own payout
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
CREATE INDEX ix_payouts_status ON payouts(business_id, status);

CREATE TABLE reconciliation_runs (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id),
  location_id   TEXT REFERENCES locations(id),
  business_date TEXT NOT NULL,           -- YYYY-MM-DD in business timezone
  status        TEXT NOT NULL CHECK (status IN ('pending','matched','partially_matched','discrepancy','resolved')),
  summary_json  TEXT,
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  superseded_by TEXT REFERENCES reconciliation_runs(id)
);
CREATE INDEX ix_recon_runs_date ON reconciliation_runs(business_id, business_date);

CREATE TABLE reconciliation_items (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES reconciliation_runs(id),
  category        TEXT NOT NULL,
  label           TEXT NOT NULL,
  reference_type  TEXT,
  reference_id    TEXT,
  expected        INTEGER NOT NULL,
  actual          INTEGER NOT NULL,
  difference      INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','matched','partially_matched','discrepancy','resolved')),
  detail          TEXT,
  resolved_by     TEXT REFERENCES users(id),
  resolved_at     TEXT,
  resolution_note TEXT
);
CREATE INDEX ix_recon_items_run ON reconciliation_items(run_id);

-- ───────────────────────── Receipts delivery ─────────────────────────────────
CREATE TABLE receipt_deliveries (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  sale_id     TEXT REFERENCES sales(id),
  refund_id   TEXT REFERENCES refunds(id),
  channel     TEXT NOT NULL CHECK (channel IN ('print','pdf','email','sms','whatsapp')),
  destination TEXT,
  status      TEXT NOT NULL CHECK (status IN ('queued','sent','failed','not_configured','done')),
  detail      TEXT,
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL
);

-- ───────────────────────── Audit, idempotency, sync ──────────────────────────
CREATE TABLE audit_logs (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  business_id  TEXT,
  occurred_at  TEXT NOT NULL,
  user_id      TEXT,
  username     TEXT,
  approved_by  TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  reference    TEXT,
  old_value    TEXT,
  new_value    TEXT,
  meta         TEXT,
  terminal     TEXT,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL
);
CREATE INDEX ix_audit_action ON audit_logs(business_id, action, occurred_at);
CREATE INDEX ix_audit_entity ON audit_logs(entity_type, entity_id);

CREATE TABLE idempotency_keys (
  key           TEXT PRIMARY KEY,
  user_id       TEXT,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  status_code   INTEGER,
  response_json TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE sync_outbox (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id     TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','sent','failed','conflict','resolved')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_attempt_at TEXT,
  created_at      TEXT NOT NULL,
  sent_at         TEXT
);
CREATE INDEX ix_outbox_status ON sync_outbox(status, next_attempt_at);

-- ───────────────────────── Test-mode simulators (not real systems) ───────────
-- Stand-in for an external payment provider's own ledger, used only by the sim-* adapters.
CREATE TABLE sim_provider_transactions (
  ref           TEXT PRIMARY KEY,
  provider_code TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('charge','refund')),
  merchant_ref  TEXT NOT NULL,
  parent_ref    TEXT,
  amount        INTEGER NOT NULL,
  currency      TEXT NOT NULL,
  status        TEXT NOT NULL,
  scenario      TEXT NOT NULL,
  resolve_at    TEXT,
  settled_ref   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (provider_code, merchant_ref)
);
-- Stand-in for a head-office server receiving synced records.
CREATE TABLE sim_hq_records (
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);

-- ───────────────────────── Integrity triggers ────────────────────────────────
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

CREATE TRIGGER movements_no_update BEFORE UPDATE ON inventory_movements BEGIN SELECT RAISE(ABORT, 'inventory_movements is append-only'); END;
CREATE TRIGGER movements_no_delete BEFORE DELETE ON inventory_movements BEGIN SELECT RAISE(ABORT, 'inventory_movements is append-only'); END;

CREATE TRIGGER sales_no_delete BEFORE DELETE ON sales BEGIN SELECT RAISE(ABORT, 'sales cannot be deleted; cancel or void instead'); END;
CREATE TRIGGER sales_final_status BEFORE UPDATE OF status ON sales
  WHEN OLD.status IN ('cancelled','voided') OR (OLD.status = 'completed' AND NEW.status NOT IN ('completed','voided'))
  BEGIN SELECT RAISE(ABORT, 'illegal sale status transition'); END;
CREATE TRIGGER sales_completed_frozen BEFORE UPDATE OF subtotal, discount_total, tax_total, total, amount_paid, change_given, customer_id ON sales
  WHEN OLD.status IN ('completed','voided','cancelled') AND (
    NEW.subtotal <> OLD.subtotal OR NEW.total <> OLD.total OR NEW.tax_total <> OLD.tax_total OR
    NEW.discount_total <> OLD.discount_total OR NEW.amount_paid <> OLD.amount_paid OR NEW.change_given <> OLD.change_given OR
    COALESCE(NEW.customer_id,'') <> COALESCE(OLD.customer_id,''))
  BEGIN SELECT RAISE(ABORT, 'completed sale totals are immutable'); END;

CREATE TRIGGER sale_items_insert_open BEFORE INSERT ON sale_items
  WHEN (SELECT status FROM sales WHERE id = NEW.sale_id) <> 'open'
  BEGIN SELECT RAISE(ABORT, 'sale is not open for editing'); END;
CREATE TRIGGER sale_items_update_open BEFORE UPDATE ON sale_items
  WHEN (SELECT status FROM sales WHERE id = OLD.sale_id) NOT IN ('open')
  BEGIN SELECT RAISE(ABORT, 'sale is not open for editing'); END;
CREATE TRIGGER sale_items_delete_open BEFORE DELETE ON sale_items
  WHEN (SELECT status FROM sales WHERE id = OLD.sale_id) <> 'open'
  BEGIN SELECT RAISE(ABORT, 'sale is not open for editing'); END;

CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments BEGIN SELECT RAISE(ABORT, 'payments cannot be deleted'); END;
CREATE TRIGGER payments_amount_frozen BEFORE UPDATE OF amount, tendered, method_code, sale_id ON payments
  WHEN OLD.status NOT IN ('pending') AND (NEW.amount <> OLD.amount OR NEW.method_code <> OLD.method_code OR NEW.sale_id <> OLD.sale_id)
  BEGIN SELECT RAISE(ABORT, 'payment amount is immutable once submitted'); END;
CREATE TRIGGER payments_terminal_status BEFORE UPDATE OF status ON payments
  WHEN OLD.status IN ('failed','cancelled','voided') AND NEW.status <> OLD.status
  BEGIN SELECT RAISE(ABORT, 'payment is in a final state'); END;
CREATE TRIGGER payments_succeeded_status BEFORE UPDATE OF status ON payments
  WHEN OLD.status = 'succeeded' AND NEW.status NOT IN ('succeeded','voided')
  BEGIN SELECT RAISE(ABORT, 'succeeded payment can only be voided'); END;

CREATE TRIGGER attempts_no_delete BEFORE DELETE ON payment_attempts BEGIN SELECT RAISE(ABORT, 'payment_attempts is append-only'); END;
CREATE TRIGGER refunds_no_delete BEFORE DELETE ON refunds BEGIN SELECT RAISE(ABORT, 'refunds cannot be deleted'); END;
CREATE TRIGGER refund_items_no_delete BEFORE DELETE ON refund_items BEGIN SELECT RAISE(ABORT, 'refund_items cannot be deleted'); END;
CREATE TRIGGER refund_payments_no_delete BEFORE DELETE ON refund_payments BEGIN SELECT RAISE(ABORT, 'refund_payments cannot be deleted'); END;
CREATE TRIGGER cash_movements_no_update BEFORE UPDATE ON cash_movements BEGIN SELECT RAISE(ABORT, 'cash_movements is append-only'); END;
CREATE TRIGGER cash_movements_no_delete BEFORE DELETE ON cash_movements BEGIN SELECT RAISE(ABORT, 'cash_movements is append-only'); END;
CREATE TRIGGER sessions_no_delete BEFORE DELETE ON register_sessions BEGIN SELECT RAISE(ABORT, 'sessions cannot be deleted'); END;
CREATE TRIGGER sessions_closed_frozen BEFORE UPDATE OF opening_float, expected_cash, counted_cash, variance ON register_sessions
  WHEN OLD.status = 'closed' BEGIN SELECT RAISE(ABORT, 'closed session figures are immutable'); END;
CREATE TRIGGER settlements_no_delete BEFORE DELETE ON settlements BEGIN SELECT RAISE(ABORT, 'settlements cannot be deleted'); END;
CREATE TRIGGER payouts_no_delete BEFORE DELETE ON payouts BEGIN SELECT RAISE(ABORT, 'payouts cannot be deleted'); END;
CREATE TRIGGER recon_items_no_delete BEFORE DELETE ON reconciliation_items BEGIN SELECT RAISE(ABORT, 'reconciliation items cannot be deleted'); END;
CREATE TRIGGER recon_items_figures_frozen BEFORE UPDATE OF expected, actual, difference ON reconciliation_items
  BEGIN SELECT RAISE(ABORT, 'reconciliation figures are immutable; re-run instead'); END;
