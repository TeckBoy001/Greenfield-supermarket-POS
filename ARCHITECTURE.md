# Meridian POS — Architecture

## 1. Shape of the system

```
┌──────────────────────── Desktop app (Electron) ─────────────────────────┐
│  Renderer (app/)           sandboxed, no Node, CSP script-src 'self'     │
│   • Checkout screen  • Back office  • Customer display window            │
│         │ fetch + Bearer token           ▲ preload.js: print, display,   │
│         ▼                                │ terminal register (IPC only)  │
│  Main process (electron/main.js) ── embeds ──► POS server (server/)      │
└──────────────────────────────────────────────────────────────────────────┘
                     POS server  =  HTTP API on 127.0.0.1
   routes.js → services/* (all business rules) → SQLite (WAL, synchronous=FULL)
        │                          │
        │                          ├─ payments/  PaymentService → provider adapters
        │                          ├─ hardware/  printer, drawer, display adapters
        │                          ├─ sync.js    transactional outbox → HQ adapter
        │                          └─ background workers: payment recovery (2 s),
        │                             connectivity probe (15 s), sync (10 s), backups (6 h)
        └─ /api/webhooks/:provider  (signature-verified provider callbacks)
```

The renderer never computes money. Every scan, discount and payment is a server call; the UI renders
server state. Closing the window, a crash or a power cut loses nothing: the cart is already a
database row.

**Deployment modes.** *Standalone* (default): each terminal embeds the server and its own database —
offline-first by construction. *Client*: lanes point at one store server on the LAN
(`terminal.json`). The same server code runs in both.

**Database driver.** `server/db/driver.js` wraps SQLite. Inside Electron it uses Node's built-in
`node:sqlite` (no native module to rebuild). Under plain Node it prefers `better-sqlite3` when
installed and falls back to `node:sqlite`. The full test suite passes on both.

## 2. Transaction safety

| Risk | Safeguard |
|---|---|
| Double click / retried request | Every payment carries a client idempotency key (UNIQUE in DB); same key → same payment. Generic `Idempotency-Key` header support for other writes (replays return the stored response; same key + different body → 409). |
| Two payments racing on one sale | Partial unique index: at most one `pending`/`processing` payment per sale. |
| Marking electronic payments paid without the provider | Only the adapter can report `succeeded`; confirmation comes from provider status queries or signature-verified webhooks. The UI has no "mark paid" for electronic methods. |
| Response lost / network drops mid-payment | Payment is committed as `pending` *before* the provider call. Network errors leave it `processing`; the recovery worker re-queries the provider by our merchant reference with backoff. Cancel is refused while the provider is unreachable (the customer may have been charged). |
| App restart during payment | On startup the recovery worker re-checks every in-flight payment and refund; the checkout screen reopens the payment dialog for the open sale. |
| Editing a paid basket | Cart edits are refused once any payment is taken or in flight (service check + DB triggers). |
| Changing history | Triggers make sales totals, payments, inventory movements, cash movements, refunds, settlements, payouts, reconciliation figures and audit logs immutable / undeletable. Corrections are new records (refund, void, adjustment). |
| Tampering with the audit trail | Audit rows are hash-chained (each row hashes its content + previous hash). `GET /api/audit/verify` detects edits even by someone bypassing triggers with raw DB access. |
| Money rounding | All money is integer minor units. Tax and cart discounts use deterministic rounding with largest-remainder allocation; line totals always sum to the sale total; partial refunds of the remainder are exact. |
| Durability | SQLite WAL with `synchronous=FULL`, short `BEGIN IMMEDIATE` transactions, automatic `VACUUM INTO` backups. |

## 3. Sale & payment lifecycle

```
sale:     open ⇄ held      open → completed (paid in full, server-side)      open/held → cancelled (nothing paid)
                           completed → voided (same session, via a void record)
payment:  pending → processing → succeeded | failed | cancelled        succeeded → voided (only before completion)
refund:   pending → completed | failed (money side; retry or pay cash)
session:  open → closed (expected vs counted, variance, review)
```

Completion is atomic: stock movements, loyalty points, sale status, audit entry and the sync-outbox
row are written in one transaction.

## 4. Payment provider architecture

```
PaymentService ──► buildProvider(code) ──► adapter implements PaymentProvider
                                           initiatePayment · getPaymentStatus · cancelPayment · voidPayment
                                           refundPayment · getRefundStatus · verifyWebhook · fetchSettlements · healthCheck
```

Included adapters: `cash` (local), `manual` (externally confirmed, e.g. standalone bank terminal —
approval code required, flagged for reconciliation), `sim-card`, `sim-transfer`, `sim-wallet`
(**test-mode simulators**, clearly labelled). `http-gateway-template.js` documents what a real
integration must do. Secrets live in an AES-256-GCM encrypted store (`keys/`), never in the database or
config JSON; the admin UI refuses secret-looking keys in plain config.

Payment methods (what the cashier sees) are data: name, type, adapter, offline allowed, reference
required, shortcut. Safety rules are enforced regardless of configuration: only cash gives change;
electronic methods can never be marked offline-capable.

## 5. Offline policy

| While providers/network are unreachable | |
|---|---|
| Cash, manual (standalone terminal), vouchers | ✅ allowed; sale completes locally, flagged `completed_offline` |
| Card (integrated), transfer, mobile money, wallet | ❌ refused server-side (503 `offline`), buttons disabled with reason |
| In-flight electronic payments | stay `processing`; re-queried on reconnect |
| Electronic refunds | refused; supervisor can refund to cash instead |
| Records for head office | queued in `sync_outbox` in the same transaction; pushed on reconnect |
| Sync conflicts (same id, different content) | marked `conflict` for a human; never silently overwritten |

A test switch (Settings → Network & sync → *Simulate network outage*) lets you rehearse this; it is
admin-only and audited.

## 6. Money flows are kept separate

| Concept | Table(s) | Meaning |
|---|---|---|
| Customer payment | `payments`, `payment_attempts` | money in from a customer for a sale |
| Refund / void | `refunds`, `refund_items`, `refund_payments` | money back to a customer, referencing original lines & payments |
| Cash movement | `cash_movements` | paid-in / paid-out / safe drop through a drawer |
| Provider settlement | `settlements`, `settlement_items` | what a provider reports it paid, net of fees, matched line-by-line |
| Payout | `payouts` | money leaving the business or moving between its accounts (provider payout received, bank deposit, supplier payment, withdrawal…) — request → approve (different person, DB CHECK) → paid |
| Reconciliation | `reconciliation_runs`, `reconciliation_items` | immutable daily snapshot comparing all of the above |

Reconciliation checks per business day: sales ↔ recorded payments; refunds ↔ money returned; each cash
session expected ↔ counted; each electronic provider's payments ↔ settlement lines (voided/reversed
charges excluded); unknown or mismatched settlement lines; settlement net ↔ funds received in bank;
cash drops ↔ bank deposits; payouts awaiting approval. Statuses: pending, matched, partially matched,
discrepancy, resolved. Resolving records who/why and never changes figures.

## 7. Data model (SQLite, `server/db/migrations/001_init.sql`)

Tenancy: `businesses → locations → registers`; `settings`, `counters`.
Access: `users`, `roles`, `permissions`, `role_permissions`, `auth_sessions`.
Catalogue: `products`, `product_barcodes` (multiple, with pack quantity), `categories`, `suppliers`, `tax_rates`.
Inventory: `stock_levels` (running total) + `inventory_movements` (append-only ledger with type, reference,
reason, user, balance after), `goods_receipts(+items)`, `stock_transfers(+items)`.
Sales: `sales`, `sale_items` (price/tax/discount snapshot per line), `customers`.
Money: see §6, plus `payment_methods`, `provider_configs`, `financial_accounts`, `webhook_events`.
Ops: `register_sessions`, `receipt_deliveries`, `audit_logs`, `idempotency_keys`, `sync_outbox`.
Simulators: `sim_provider_transactions`, `sim_hq_records` (stand-ins for external systems).

IDs are time-sortable text IDs (safe across terminals). Business-facing numbers are gap-accounted
(receipt numbers are allocated when a sale opens; cancelled sales keep their number).

## 8. Roles (editable)

| Role | Highlights | Max discount without approval |
|---|---|---|
| Owner | everything | 100% |
| Manager | operations, inventory, reports, staff oversight; not user/settings admin | 30% |
| Shift supervisor | checkout + approvals (refunds, voids, price overrides, cash in/out), variance review | 15% |
| Cashier | checkout, customers, start refunds (needs approval), open/close own session | 5% |
| Inventory staff | products (not prices), receive/adjust/transfer | — |
| Finance | payments, settlements, payouts (approve others'), reconciliation, audit | — |

Supervisor overrides: a cashier's request is approved by entering another user's username + PIN; the
approver must hold the permission, can't be the requester, and for discounts their own limit applies.
Only owners can grant the Owner role; users can't grant permissions they don't have.

## 9. Security

scrypt password/PIN hashing with lockout; DB-backed sessions (idle + absolute expiry); bearer tokens
(not cookies) + Origin checks on writes; Host-header allow-list (DNS-rebinding protection); CSP on app
and receipts; output escaping by default in the UI template helper; CSV formula-injection guard;
input validation on every endpoint; PII minimised in audit logs and receipt-delivery records (masked
destinations, customer field names only); bank accounts store last 4 digits only; no card data ever.

## 10. Integration status (honest)

| Area | Status |
|---|---|
| Barcode scanners (keyboard wedge), scale labels | Integrated |
| Receipt printing via OS printer (desktop print dialog) | Integrated |
| ESC/POS network printer & drawer kick | Implemented to protocol, **not verified on hardware** |
| Print spool folder | Integrated |
| Customer display (second window / monitor) | Integrated |
| Serial scanners, pole displays, serial scales, label printers | Not integrated (adapter points documented) |
| Real card terminals / gateways / bank-transfer / mobile-money APIs | **Not integrated** — simulated test providers + adapter template |
| Email / SMS / WhatsApp receipts | Architecture only; requests are recorded as `not_configured` |
| Head-office sync | Outbox + simulated HQ; HTTP adapter implemented but not tested against a real HQ service |
| Automatic promotions engine (e.g. buy-2-get-1) | Not built; manual discounts with limits/approval are |

## 11. Extending

* New payment provider: implement `PaymentProvider`, register in `providers/index.js`, configure via Settings → Payment methods.
* New device: add an adapter in `server/services/hardware/` and list it in `DEVICES`.
* New report: add an entry to `REPORTS` in `server/services/reports.js` (columns + run) — UI, CSV and PDF export pick it up.
* Schema change: add `server/db/migrations/002_*.sql`; migrations run on startup inside a transaction.
