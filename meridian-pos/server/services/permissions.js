'use strict';
/** Permission catalogue and default role templates. Roles are editable data; these are only seeds. */

const PERMISSIONS = [
  // POS
  ['pos.sell', 'Checkout', 'Ring up sales on a register'],
  ['pos.discount', 'Checkout', 'Apply discounts up to the role limit'],
  ['pos.discount.unlimited', 'Checkout', 'Apply discounts above the role limit / approve discount overrides'],
  ['pos.price_override', 'Checkout', 'Change an item price at the till'],
  ['pos.line_remove_after_payment', 'Checkout', 'Remove lines or payments once tendering started'],
  ['sale.cancel', 'Checkout', 'Cancel an unpaid sale'],
  ['sale.void', 'Checkout', 'Void a completed sale (same session only)'],
  ['sale.view_all', 'Sales', 'View all sales, not just own'],
  ['payment.manual_confirm', 'Payments', 'Record externally-confirmed payments (e.g. standalone card terminal approval code)'],
  ['payment.view', 'Payments', 'View payment records and provider status'],
  ['payment.resolve', 'Payments', 'Re-check or cancel stuck electronic payments'],
  ['refund.create', 'Refunds', 'Start refunds/returns'],
  ['refund.approve', 'Refunds', 'Authorize refunds (supervisor)'],
  // sessions
  ['session.open_close', 'Cash', 'Open and close own register session'],
  ['session.cash_movement', 'Cash', 'Record paid-in / paid-out / cash drops'],
  ['session.manage_all', 'Cash', 'View and close any session, review variances'],
  // catalogue & inventory
  ['product.view', 'Catalogue', 'View products'],
  ['product.edit', 'Catalogue', 'Create and edit products (not price)'],
  ['product.price', 'Catalogue', 'Change selling price and cost'],
  ['inventory.view', 'Inventory', 'View stock levels and movements'],
  ['inventory.adjust', 'Inventory', 'Adjust stock, record damage/stocktake'],
  ['inventory.receive', 'Inventory', 'Receive stock from suppliers'],
  ['inventory.transfer', 'Inventory', 'Transfer stock between locations'],
  // customers
  ['customer.view', 'Customers', 'View customers'],
  ['customer.edit', 'Customers', 'Create and edit customers'],
  // finance
  ['report.view', 'Reports', 'Operational reports (sales, products, inventory)'],
  ['report.financial', 'Reports', 'Financial reports (margins, taxes, payments)'],
  ['settlement.manage', 'Finance', 'Import and match provider settlements'],
  ['payout.request', 'Finance', 'Request payouts and bank deposits'],
  ['payout.approve', 'Finance', 'Approve/reject payouts (cannot approve own)'],
  ['reconciliation.manage', 'Finance', 'Run reconciliation and resolve discrepancies'],
  // admin
  ['user.manage', 'Administration', 'Manage staff accounts and roles'],
  ['settings.manage', 'Administration', 'Change business, tax, payment and hardware settings'],
  ['audit.view', 'Administration', 'View the audit log'],
  ['sync.manage', 'Administration', 'View and resolve sync queue / network simulation'],
];

const ALL = PERMISSIONS.map((p) => p[0]);

const ROLE_TEMPLATES = [
  { code: 'owner', name: 'Owner / Super Admin', description: 'Full access', max_discount_pct: 100, permissions: ALL },
  {
    code: 'manager', name: 'Store Manager', description: 'Operations, inventory, reports, staff oversight', max_discount_pct: 30,
    permissions: ALL.filter((p) => !['user.manage', 'settings.manage', 'payout.approve', 'sync.manage'].includes(p)),
  },
  {
    code: 'supervisor', name: 'Shift Supervisor', description: 'Checkout plus overrides, refunds and cash control', max_discount_pct: 15,
    permissions: ['pos.sell', 'pos.discount', 'pos.price_override', 'pos.line_remove_after_payment', 'sale.cancel', 'sale.void', 'sale.view_all',
      'payment.manual_confirm', 'payment.view', 'payment.resolve', 'refund.create', 'refund.approve', 'session.open_close', 'session.cash_movement',
      'session.manage_all', 'product.view', 'inventory.view', 'customer.view', 'customer.edit', 'report.view'],
  },
  {
    code: 'cashier', name: 'Cashier', description: 'Checkout and assigned POS functions', max_discount_pct: 5,
    permissions: ['pos.sell', 'pos.discount', 'sale.cancel', 'payment.manual_confirm', 'refund.create', 'session.open_close', 'product.view', 'customer.view', 'customer.edit'],
  },
  {
    code: 'inventory', name: 'Inventory Staff', description: 'Stock management', max_discount_pct: 0,
    permissions: ['product.view', 'product.edit', 'inventory.view', 'inventory.adjust', 'inventory.receive', 'inventory.transfer', 'report.view'],
  },
  {
    code: 'finance', name: 'Accountant / Finance', description: 'Payments, settlements, payouts, reconciliation, financial reporting', max_discount_pct: 0,
    permissions: ['sale.view_all', 'payment.view', 'payment.resolve', 'session.manage_all', 'product.view', 'inventory.view', 'customer.view', 'report.view', 'report.financial',
      'settlement.manage', 'payout.request', 'payout.approve', 'reconciliation.manage', 'audit.view'],
  },
];

module.exports = { PERMISSIONS, ROLE_TEMPLATES, ALL };
