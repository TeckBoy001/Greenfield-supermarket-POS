# Meridian POS

A desktop checkout and business-operations platform for medium-sized retailers — built around a real
supermarket workflow, configurable for pharmacies, hardware, electronics, fashion and convenience stores.

```
PRODUCT → INVENTORY → SCAN → CART → CHECKOUT → PAYMENT → RECEIPT → INVENTORY UPDATE
        → SETTLEMENT → PAYOUT → RECONCILIATION → REPORTING
```

Every stage is one connected ledger: a scan writes to the server-side cart, a payment is confirmed by
its provider, completion deducts stock through movements, settlements are matched line-by-line to
payments, and reconciliation compares all of it for each business day.

---

## Quick start

Requirements: **Node.js 22.5+** (for the standalone server/tests). The desktop app bundles its own runtime.

```bash
npm install            # installs Electron (+ optional native SQLite driver)
npm start              # desktop app (Electron) — seeds the demo supermarket on first run
```

Browser / server-only mode (e.g. a back-office "store server" that several lanes connect to):

```bash
npm run server         # http://127.0.0.1:4780  (demo data in ./data)
npm run server:fresh   # clean business, prints a one-time owner password
```

### Demo accounts (password `demo1234` for all)

| Username     | Role                 | PIN  | What to try |
|--------------|----------------------|------|-------------|
| `cashier1`   | Cashier              | 1470 | Pick *Lekki — Lane 1* on the sign-in screen → open register → scan |
| `supervisor` | Shift supervisor     | 3791 | Approves discounts, refunds, voids, cash in/out (enter username + PIN in the approval prompt) |
| `manager`    | Store manager        | 4826 | Dashboard, products, inventory, reports |
| `stock`      | Inventory staff      | 5913 | Receive, adjust, transfer stock |
| `finance`    | Accountant / finance | 7342 | Settlements, payouts, reconciliation |
| `owner`      | Owner / super admin  | 2580 | Everything incl. staff, roles, settings |

Demo data: *Greenfield Supermarket* (Lagos) — 3 locations, 4 lanes, 60 products (incl. weighed produce,
case barcodes, age-restricted drinks), 20 customers and ~10 days of trading history (≈850 sales,
refunds, voids, cash drops, settlements with fees, one deliberate settlement discrepancy, bank
deposits, reconciliation runs, a payout awaiting approval). Lane 2 has an open session from "today".

### Barcodes to scan in the demo

| Barcode | Item |
|---|---|
| `6150040000004` | Mama Gold Rice 5kg |
| `6150040012335` | Coca-Cola 50cl (scan twice → quantity 2) |
| `6150080012333` | Coca-Cola **case** barcode → adds 12 |
| `6150080008220` | Indomie **carton** → adds 40 |
| `3*6150040024666` | 3 × Peak milk (quantity prefix) |
| `2110001012501` | Scale label: Tomatoes 1.250 kg (price-embedded EAN-13, prefix 21) |
| `6150040069872` | Andre Rosé (age-restricted → ID prompt) |

Any USB/Bluetooth scanner in keyboard (HID) mode works — it types the code and presses Enter.

### Checkout keys

`F2` search / price check · `F3` quantity · `F4` hold · `F5` recall · `F6` discount · `F7` customer ·
`F8` cash · `F9` card · `F10` transfer · `↑/↓` select line · `+/−` quantity · `Del` remove line ·
`Ctrl+L` lock · `F1` help. (Reload is `Ctrl+Shift+R` because F5 is *recall*.)

---

## Test mode payments

No real payment processor is connected. Electronic methods use **simulated providers** that behave
like real ones — asynchronous confirmation, status queries, HMAC-signed webhooks, refunds, voids and
settlement reports with fees — and every screen says **TEST MODE**.

* Card: auto-approves after ~2.5 s. Amounts ending in **.51** are declined; **.52** wait for the simulator.
* Bank transfer / mobile money: shows payment instructions and waits; use the yellow simulator box
  (*Customer approves / Declined / Times out*).
* *Card (standalone POS)*: for a bank terminal that is **not** integrated — cashier records the approval
  code; flagged as manually confirmed and reconciled against settlements.

To go live, implement a provider adapter (see `server/services/payments/providers/http-gateway-template.js`)
and register it in `providers/index.js`. Card data never passes through this application.

---

## Tests

```bash
npm test                # 30 end-to-end API tests (real server + seeded DB)
POS_DB_DRIVER=node npm test   # same suite on the built-in node:sqlite driver
npm run test:ui         # browser UI test of every role's workflow (needs: pip install playwright && playwright install chromium)
```

What the suites cover: authentication & lockout, role permissions, host/origin checks, scanning (merge,
case, multiplier, scale labels, check digits), pricing & tax maths, discount limits & supervisor
overrides, cash/card/transfer/manual/split payments, declines, duplicate submission & idempotency,
forged/replayed webhooks, offline mode, network loss mid-payment, application restart recovery,
hold/resume/cancel, partial & full refunds (cash and provider), voids, cash sessions with blind count
and variance review, inventory ledger integrity, product/price audit, settlements & discrepancies,
payout segregation of duties, reconciliation, receipts (HTML/text/PDF, XSS escaping), reports vs
ledger, audit immutability and tamper detection.

---

## Deploying

* **Single-lane or offline-first lane:** run the desktop app (standalone mode). Data lives in the OS
  user-data folder (`…/Meridian POS/data`), with automatic backups every 6 h and on exit (14 kept).
* **Several lanes, one store:** run `node server/index.js --host 0.0.0.0 --allow-host <server-ip>:4780`
  on a back-office machine and set each lane's `terminal.json` to `{"mode":"client","serverUrl":"http://<server-ip>:4780"}`
  (File → Terminal setup). Put the store server on a UPS.
* **Packaging:** `npm run dist` (electron-builder) produces an installer for the current OS.
* **Head office sync:** completed sales, refunds and sessions are queued in a transactional outbox and
  pushed when online. The built-in target is a simulated HQ; set `sync.adapter` to `http` and
  `sync.endpoint` for a real service.

See `docs/ARCHITECTURE.md` for the design, data model and the list of what is and isn't integrated.
