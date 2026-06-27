// Double-entry ledger.
//
// Rules enforced here:
//  1. Every journal entry's postings sum to ZERO (debits balance credits).
//  2. Postings are append-only — never updated or deleted.
//  3. Cached balances are updated inside the SAME db transaction as the postings.
//  4. A merchant's available balance is the cached balance of their
//     'merchant_available' account, reconcilable from SUM(postings).
//
// Sign convention: amount is signed. A credit is positive, a debit is negative.
// For an "available" liability-style account, a positive balance = money the
// merchant can withdraw.

import { db } from '../../db/index.js';
import { id, ApiError } from '../../lib/util.js';

const SYSTEM_TYPES = ['psp_clearing', 'fees_income', 'settlement_payable'];

/** Ensure system accounts exist (idempotent). Called at startup. */
export function ensureSystemAccounts(currency = 'GHS') {
  for (const type of SYSTEM_TYPES) {
    const existing = db.get(
      `SELECT id FROM ledger_accounts WHERE merchant_id IS NULL AND type = ? AND currency = ?`,
      [type, currency]
    );
    if (!existing) {
      const acctId = id('acct');
      db.run(
        `INSERT INTO ledger_accounts (id, merchant_id, type, currency) VALUES (?, NULL, ?, ?)`,
        [acctId, type, currency]
      );
      db.run(`INSERT INTO account_balances (account_id, balance) VALUES (?, 0)`, [acctId]);
    }
  }
}

export function getSystemAccount(type, currency = 'GHS') {
  const row = db.get(
    `SELECT id FROM ledger_accounts WHERE merchant_id IS NULL AND type = ? AND currency = ?`,
    [type, currency]
  );
  if (!row) throw new Error(`system account ${type} missing — run ensureSystemAccounts`);
  return row.id;
}

/** Create (or fetch) a merchant's available account. */
export function ensureMerchantAccount(merchantId, currency = 'GHS') {
  const existing = db.get(
    `SELECT id FROM ledger_accounts WHERE merchant_id = ? AND type = 'merchant_available' AND currency = ?`,
    [merchantId, currency]
  );
  if (existing) return existing.id;
  const acctId = id('acct');
  db.run(
    `INSERT INTO ledger_accounts (id, merchant_id, type, currency) VALUES (?, ?, 'merchant_available', ?)`,
    [acctId, merchantId, currency]
  );
  db.run(`INSERT INTO account_balances (account_id, balance) VALUES (?, 0)`, [acctId]);
  return acctId;
}

/**
 * Post a balanced journal entry.
 * @param {{kind:string, paymentId?:string, description?:string,
 *          postings: Array<{accountId:string, amount:number}>}} entry
 * Must be called INSIDE a db.tx(...) by the caller so it's atomic with related writes.
 */
export function postEntry({ kind, paymentId = null, description = '', postings }) {
  const sum = postings.reduce((s, p) => s + p.amount, 0);
  if (sum !== 0) {
    throw new ApiError(500, 'ledger_unbalanced', `postings sum to ${sum}, must be 0`);
  }
  const entryId = id('jrn');
  db.run(
    `INSERT INTO journal_entries (id, kind, payment_id, description) VALUES (?, ?, ?, ?)`,
    [entryId, kind, paymentId, description]
  );
  for (const p of postings) {
    db.run(`INSERT INTO postings (entry_id, account_id, amount) VALUES (?, ?, ?)`, [
      entryId,
      p.accountId,
      p.amount,
    ]);
    db.run(
      `UPDATE account_balances SET balance = balance + ?, updated_at = datetime('now') WHERE account_id = ?`,
      [p.amount, p.accountId]
    );
  }
  return entryId;
}

export function getBalance(accountId) {
  const row = db.get(`SELECT balance FROM account_balances WHERE account_id = ?`, [accountId]);
  return row ? row.balance : 0;
}

export function getMerchantBalance(merchantId, currency = 'GHS') {
  const acct = db.get(
    `SELECT id FROM ledger_accounts WHERE merchant_id = ? AND type = 'merchant_available' AND currency = ?`,
    [merchantId, currency]
  );
  return acct ? getBalance(acct.id) : 0;
}

/**
 * Integrity check: recompute a balance from raw postings and compare to the
 * cached value. Used by tests and a periodic reconciliation job.
 */
export function reconcileAccount(accountId) {
  const summed = db.get(
    `SELECT COALESCE(SUM(amount),0) AS s FROM postings WHERE account_id = ?`,
    [accountId]
  ).s;
  const cached = getBalance(accountId);
  return { accountId, summed, cached, ok: summed === cached };
}
