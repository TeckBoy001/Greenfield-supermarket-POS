#!/usr/bin/env python3
"""
Browser-level UI test: drives the real desktop UI (Chromium) through the complete supermarket
workflow for each role, fails on any JavaScript error, and saves screenshots for UI review.

    python3 tests/ui_test.py            (needs: pip install playwright && playwright install chromium)
"""
import os, re, subprocess, sys, tempfile, time, json, shutil, urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get('UI_PORT', '4799'))
BASE = f'http://127.0.0.1:{PORT}'
SHOTS = os.environ.get('SHOTS', os.path.join(ROOT, 'tests', 'screenshots'))
os.makedirs(SHOTS, exist_ok=True)
DATA = tempfile.mkdtemp(prefix='meridian-ui-')
errors, results = [], []

def ean13(b12):
    s = sum(int(d) * (3 if i % 2 else 1) for i, d in enumerate(b12)); return b12 + str((10 - s % 10) % 10)

def step(name):
    def deco(fn):
        def run(*a):
            t = time.time()
            try: fn(*a); results.append(('ok', name, time.time() - t))
            except Exception as e:
                results.append(('FAIL', name, time.time() - t)); print(f'FAIL {name}: {e}')
                try: a[0].screenshot(path=os.path.join(SHOTS, f'FAIL-{re.sub("[^a-z0-9]+", "-", name.lower())}.png'))
                except Exception: pass
                raise
        return run
    return deco

def shot(pg, name): pg.wait_for_timeout(250); pg.screenshot(path=os.path.join(SHOTS, f'{name}.png'))

def login(pg, user, register=None, pin=None):
    pg.goto(BASE); pg.evaluate('sessionStorage.clear()'); pg.goto(BASE + '/?fresh'); pg.wait_for_selector('form.auth-card')
    pg.select_option('#reg', label=register) if register else pg.select_option('#reg', value='')
    pg.fill('#u', user)
    if pin: pg.click('[data-m=pin]'); pg.fill('#pin', pin)
    else: pg.fill('#p', 'demo1234')
    pg.click('form.auth-card button[type=submit]')

def scan(pg, code):
    pg.keyboard.type(code, delay=3); pg.keyboard.press('Enter'); pg.wait_for_timeout(300)

def override(pg):
    dlg = pg.locator('.modal:has-text("Supervisor approval")')
    dlg.wait_for(); dlg.locator('input[name=username]').fill('supervisor'); dlg.locator('input[name=pin]').fill('3791'); dlg.locator('[data-ok]').click()

def modal_closed(pg): pg.wait_for_function('() => !document.querySelector(".overlay")', timeout=8000)

@step('cashier: open register, scan, weigh, age check, discount override, hold/recall, cash sale')
def cashier_sale(pg):
    login(pg, 'cashier1', 'Lekki Phase 1 — Lane 1 (LEK-R01)')
    pg.wait_for_selector('[data-float]'); shot(pg, '10-open-register')
    pg.click('text=Open register'); pg.wait_for_selector('[data-scan]')
    scan(pg, '6150040000004'); scan(pg, '6150040012335'); scan(pg, '6150040012335'); scan(pg, '2*6150040024666')
    expect(pg.locator('[data-cart] tbody tr')).to_have_count(3)
    # weighed item via search → weight prompt
    pg.keyboard.press('F2'); pg.wait_for_selector('.modal [data-q]'); pg.fill('.modal [data-q]', 'Onions'); pg.wait_for_timeout(500)
    shot(pg, '11-search'); pg.keyboard.press('Enter')
    pg.wait_for_selector('.modal:has-text("Enter weight")'); pg.fill('.modal input[name=w]', '0.85'); pg.click('.modal [data-ok]'); modal_closed(pg)
    # age-restricted
    scan(pg, '6150040069872'); pg.wait_for_selector('.modal:has-text("Age-restricted")'); shot(pg, '12-age-check'); pg.click('.modal [data-ok]'); modal_closed(pg)
    expect(pg.locator('[data-cart] tbody tr')).to_have_count(5)
    # discount above cashier limit → supervisor
    pg.keyboard.press('F6'); pg.wait_for_selector('.modal select[name=scope]')
    pg.select_option('.modal select[name=scope]', 'cart'); pg.fill('.modal input[name=value]', '10'); pg.click('.modal:has-text("Apply discount") [data-ok]')
    override(pg); modal_closed(pg)
    expect(pg.locator('[data-totals]')).to_contain_text('Discounts'); shot(pg, '13-cart-discounted')
    # hold & recall
    pg.keyboard.press('F4'); pg.wait_for_selector('.modal:has-text("Hold sale")'); pg.fill('.modal input[name=label]', 'Blue shirt, fetching wallet'); pg.click('.modal [data-ok]'); modal_closed(pg)
    expect(pg.locator('.cart-empty')).to_be_visible()
    pg.keyboard.press('F5'); pg.wait_for_selector('.modal:has-text("Held sales")'); shot(pg, '14-held'); pg.click('.modal [data-id] >> nth=0'); modal_closed(pg)
    expect(pg.locator('[data-cart] tbody tr')).to_have_count(5)
    # cash with change
    pg.keyboard.press('F8'); pg.wait_for_selector('[data-amt]'); pg.click('.quick-cash button >> nth=2'); shot(pg, '15-cash-tender')
    pg.keyboard.press('Enter'); pg.wait_for_selector('h2:text-is("Sale complete")'); pg.wait_for_timeout(600); shot(pg, '16-sale-complete')
    assert 'Change due' in pg.inner_text('.modal')
    pg.click('.modal [data-dismiss]'); modal_closed(pg)

@step('cashier: card (auto-approve), transfer (simulator), decline then split tender')
def electronic(pg):
    scan(pg, '6150040067137'); pg.keyboard.press('F9'); pg.wait_for_selector('[data-send]'); pg.click('[data-send]')
    pg.wait_for_selector('.pay-status'); shot(pg, '20-card-processing')
    pg.wait_for_selector('h2:text-is("Sale complete")', timeout=12000); pg.click('.modal [data-dismiss]'); modal_closed(pg)
    scan(pg, '6150040076726'); pg.keyboard.press('F10'); pg.wait_for_selector('[data-send]'); pg.click('[data-send]')
    pg.wait_for_selector('[data-sim=approve]'); shot(pg, '21-transfer-instructions'); pg.click('[data-sim=approve]')
    pg.wait_for_selector('h2:text-is("Sale complete")', timeout=10000); pg.click('.modal [data-dismiss]'); modal_closed(pg)
    # decline: amount ending .51
    scan(pg, '6150040076726'); pg.keyboard.press('F9'); pg.wait_for_selector('[data-send]')
    pg.fill('.modal [data-amt]', '5000.51'); pg.click('[data-send]')
    pg.wait_for_selector('.modal:has-text("Declined")', timeout=12000); shot(pg, '22-card-declined')
    pg.click('.modal:has-text("Choose another method") [data-dismiss]'); modal_closed(pg)
    pg.keyboard.press('F8'); pg.wait_for_selector('[data-amt]'); pg.fill('[data-amt]', '5000'); pg.keyboard.press('Enter'); modal_closed(pg)
    expect(pg.locator('[data-totals]')).to_contain_text('Balance due'); shot(pg, '23-split-partial')
    pg.click('[data-method=ext_pos]'); pg.wait_for_selector('.modal input[name=reference]')
    pg.fill('.modal input[name=reference]', '552199'); pg.check('.modal input[name=confirm]'); pg.click('.modal [data-ok]')
    pg.wait_for_selector('h2:text-is("Sale complete")'); pg.click('.modal [data-dismiss]'); modal_closed(pg)

@step('cashier: offline mode disables electronic payments, cash still completes')
def offline(pg, owner_token):
    req = urllib.request.Request(f'{BASE}/api/network/simulate', data=json.dumps({'offline': True}).encode(), headers={'content-type': 'application/json', 'authorization': f'Bearer {owner_token}'}, method='POST')
    urllib.request.urlopen(req).read()
    pg.reload(); pg.wait_for_selector('.warn-strip', timeout=15000)
    scan(pg, '6150040078096')
    assert pg.locator('[data-method=card]').is_disabled()
    shot(pg, '30-offline')
    pg.keyboard.press('F8'); pg.wait_for_selector('[data-amt]'); pg.keyboard.press('Enter'); pg.wait_for_selector('text=Completed offline'); pg.click('.modal [data-dismiss]'); modal_closed(pg)
    req = urllib.request.Request(f'{BASE}/api/network/simulate', data=json.dumps({'offline': False}).encode(), headers={'content-type': 'application/json', 'authorization': f'Bearer {owner_token}'}, method='POST')
    urllib.request.urlopen(req).read()

@step('cashier: return with supervisor approval, cash in/out, blind close')
def returns_and_close(pg):
    pg.click('[data-act=returns]'); pg.wait_for_selector('.modal [data-q]'); pg.fill('.modal [data-q]', 'LEK-R01'); pg.wait_for_timeout(700)
    pg.click('.modal [data-id] >> nth=0'); pg.wait_for_selector('.modal:has-text("Refund —")')
    pg.check('.modal tr[data-line] [data-pick] >> nth=0'); pg.fill('.modal [data-note]', 'Customer changed mind'); shot(pg, '40-refund-select')
    pg.click('.modal [data-go]'); override(pg)
    pg.wait_for_selector('.modal:has-text("Money returned")'); shot(pg, '41-refund-done'); pg.click('.modal [data-dismiss]'); modal_closed(pg)
    pg.click('[data-act=cash]'); pg.wait_for_selector('.modal select[name=type]'); pg.select_option('.modal select[name=type]', 'cash_drop')
    pg.fill('.modal input[name=amount]', '20000'); pg.fill('.modal input[name=reason]', 'Safe drop'); pg.click('.modal [data-ok]'); override(pg); modal_closed(pg)
    pg.click('[data-act=close]'); pg.wait_for_selector('.modal [data-total]'); shot(pg, '42-close-count')
    assert 'blind count' in pg.inner_text('.modal')
    pg.fill('.modal [data-den="100000"]', '1'); pg.click('.modal [data-go]')
    pg.wait_for_selector('.modal:has-text("Session closed")'); shot(pg, '43-session-closed'); pg.click('.modal [data-dismiss]'); modal_closed(pg)
    pg.wait_for_selector('[data-float]')

@step('manager: dashboard, sales detail, products, inventory adjust, reports')
def manager(pg):
    login(pg, 'manager'); pg.wait_for_selector('.kpi'); pg.wait_for_timeout(600); shot(pg, '50-dashboard')
    pg.goto(f'{BASE}/#/sales'); pg.wait_for_selector('tr[data-id]'); shot(pg, '51-sales'); pg.click('tr[data-id] >> nth=0'); pg.wait_for_selector('.modal iframe'); pg.wait_for_timeout(500); shot(pg, '52-sale-detail'); pg.keyboard.press('Escape'); modal_closed(pg)
    pg.goto(f'{BASE}/#/products'); pg.wait_for_selector('tr[data-id]'); shot(pg, '53-products'); pg.click('tr[data-id] >> nth=0'); pg.wait_for_selector('.modal input[name=name]'); shot(pg, '54-product-edit'); pg.keyboard.press('Escape'); modal_closed(pg)
    pg.goto(f'{BASE}/#/inventory'); pg.wait_for_selector('.tabs'); pg.wait_for_timeout(500); shot(pg, '55-inventory')
    pg.click('[data-adjust]'); pg.wait_for_selector('.modal [data-ps]'); pg.fill('.modal [data-ps]', 'Harpic'); pg.wait_for_timeout(500); pg.click('.modal [data-pick] >> nth=0')
    pg.fill('.modal [data-qty]', '40'); pg.fill('.modal [data-reason]', 'Aisle 7 count'); pg.click('.modal [data-go]'); modal_closed(pg)
    pg.goto(f'{BASE}/#/sessions'); pg.wait_for_selector('.panel'); pg.wait_for_timeout(500); shot(pg, '56-sessions')
    pg.goto(f'{BASE}/#/reports'); pg.wait_for_selector('.panel-head h2'); pg.wait_for_timeout(500); shot(pg, '57-reports')
    pg.click('[data-rep=product_performance]'); pg.wait_for_selector('text=Product performance'); pg.wait_for_timeout(400)
    with pg.expect_download() as d: pg.click('[data-csv]')
    assert d.value.suggested_filename.endswith('.csv')
    pg.goto(f'{BASE}/#/customers'); pg.wait_for_selector('tr[data-id]'); pg.click('tr[data-id] >> nth=0'); pg.wait_for_selector('.modal .kpi'); shot(pg, '58-customer'); pg.keyboard.press('Escape')

@step('finance: settlements, payouts approval rules, reconciliation')
def finance(pg):
    login(pg, 'finance'); pg.wait_for_selector('.kpi')
    pg.goto(f'{BASE}/#/settlements'); pg.wait_for_selector('tr[data-id]'); shot(pg, '60-settlements')
    pg.click('tr[data-id]:has-text("Discrepancy")'); pg.wait_for_selector('.modal .kpi'); shot(pg, '61-settlement-discrepancy'); pg.keyboard.press('Escape'); modal_closed(pg)
    pg.click('[data-fetch]'); pg.wait_for_selector('.modal select[name=provider_code]'); pg.check('.modal input[name=include_today]'); pg.click('.modal [data-ok]'); modal_closed(pg)
    pg.goto(f'{BASE}/#/payouts'); pg.wait_for_selector('.panel'); pg.wait_for_timeout(400); shot(pg, '62-payouts')
    pg.click('tr[data-id]:has-text("Pending Approval")'); pg.wait_for_selector('.modal:has-text("Waiting for another")'); shot(pg, '63-payout-own'); pg.keyboard.press('Escape'); modal_closed(pg)
    pg.goto(f'{BASE}/#/reconciliation'); pg.wait_for_selector('tr[data-id]'); pg.click('[data-run]'); pg.wait_for_selector('.modal input[name=business_date]'); pg.click('.modal [data-ok]')
    pg.wait_for_selector('.modal:has-text("Reconciliation —")'); pg.wait_for_timeout(300); shot(pg, '64-reconciliation')

@step('owner: settings, payment adapters, hardware status, audit verify, staff & roles')
def owner(pg):
    login(pg, 'owner'); pg.wait_for_selector('.kpi')
    for tab in ['business', 'payments', 'hardware', 'network']:
        pg.goto(f'{BASE}/#/settings/{tab}'); pg.wait_for_selector('.tabs'); pg.wait_for_timeout(500); shot(pg, f'70-settings-{tab}')
    pg.goto(f'{BASE}/#/audit'); pg.wait_for_selector('tr[data-seq]'); pg.click('[data-verify]'); pg.wait_for_selector('.toast.ok'); shot(pg, '71-audit')
    pg.goto(f'{BASE}/#/staff'); pg.wait_for_selector('tr[data-uid]'); pg.click('[data-tab=roles]'); pg.wait_for_selector('tr[data-rid]'); pg.click('tr[data-rid]:has-text("Cashier")'); pg.wait_for_selector('.modal input[name=perm]'); shot(pg, '72-role-editor'); pg.keyboard.press('Escape')

@step('permissions: cashier cannot reach finance or admin screens')
def perms(pg):
    login(pg, 'cashier2', 'Lekki Phase 1 — Lane 2 (LEK-R02)', pin='2690'); pg.wait_for_selector('[data-scan], [data-float]')
    pg.goto(f'{BASE}/#/payouts'); pg.wait_for_selector('text=Not available for your role')
    pg.goto(f'{BASE}/#/staff'); pg.wait_for_selector('text=Not available for your role')

def main():
    env = dict(os.environ, POS_LOG='error')
    proc = subprocess.Popen(['node', os.path.join(ROOT, 'server', 'index.js'), '--port', str(PORT), '--data', DATA], env=env)
    try:
        for _ in range(120):
            try: urllib.request.urlopen(f'{BASE}/api/health'); break
            except Exception: time.sleep(0.25)
        owner_token = json.loads(urllib.request.urlopen(urllib.request.Request(f'{BASE}/api/auth/login', data=json.dumps({'username': 'owner', 'password': 'demo1234'}).encode(), headers={'content-type': 'application/json'})).read())['token']
        with sync_playwright() as p:
            b = p.chromium.launch()
            ctx = b.new_context(viewport={'width': 1440, 'height': 900}, accept_downloads=True)
            pg = ctx.new_page()
            pg.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
            pg.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type == 'error' and 'Failed to load resource' not in m.text else None)
            try:
                cashier_sale(pg); electronic(pg); offline(pg, owner_token); returns_and_close(pg)
                manager(pg); finance(pg); owner(pg); perms(pg)
            except Exception:
                pass
            b.close()
    finally:
        proc.terminate(); proc.wait(timeout=10); shutil.rmtree(DATA, ignore_errors=True)
    for r in results: print(f'{r[0]:4} {r[1]} ({r[2]:.1f}s)')
    if errors: print('JS errors:\n  ' + '\n  '.join(errors))
    ok = all(r[0] == 'ok' for r in results) and len(results) == 8 and not errors
    print(f'\nUI test {"PASSED" if ok else "FAILED"} — screenshots in {SHOTS}')
    sys.exit(0 if ok else 1)

if __name__ == '__main__':
    main()
