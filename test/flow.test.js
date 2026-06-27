// End-to-end test of the money path WITHOUT the HTTP layer, plus ledger integrity.
// Run: node test/flow.test.js

import assert from 'node:assert';
import { test } from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';

process.env.SQLITE_PATH = './test.db';
process.env.MOCK_CALLBACK_DELAY_MS = '10';

if (existsSync('./test.db')) unlinkSync('./test.db');

const { migrate } = await import('../src/db/migrate.js');
const { ensureSystemAccounts, getMerchantBalance, getSystemAccount, getBalance, reconcileAccount } =
  await import('../src/modules/ledger/ledger.service.js');
const { initPsp } = await import('../src/modules/payments/psp.js');
const { createPayment, handlePspCallback, refundPayment } = await import(
  '../src/modules/payments/payment.service.js'
);
const { signup } = await import('../src/modules/auth/auth.service.js');
const { db } = await import('../src/db/index.js');

migrate();
ensureSystemAccounts('GHS');

// Capture PSP callbacks. Tests wait for the callback matching a specific
// providerReference so a stray callback from another test can't be consumed here.
let lastCallback = null;
const cbBuffer = [];
const cbWaiters = []; // { ref, resolve }
initPsp({
  onCallback: async (cb) => {
    lastCallback = cb;
    const idx = cbWaiters.findIndex((w) => !w.ref || w.ref === cb.providerReference);
    if (idx >= 0) {
      const [w] = cbWaiters.splice(idx, 1);
      w.resolve(cb);
    } else {
      cbBuffer.push(cb);
    }
  },
});

// Wait for the callback for a given providerReference (or the next one if omitted).
function waitForCallback(ref) {
  const idx = cbBuffer.findIndex((cb) => !ref || cb.providerReference === ref);
  if (idx >= 0) return Promise.resolve(cbBuffer.splice(idx, 1)[0]);
  return new Promise((resolve) => cbWaiters.push({ ref, resolve }));
}

test('signup creates merchant, user, key, and ledger account', async () => {
  const r = await signup({ businessName: 'Ama Provisions', email: 'ama@example.com', password: 'supersecret' });
  assert.ok(r.merchant.id.startsWith('mrch_'));
  assert.ok(r.apiKey.secretKey.startsWith('sk_live_'));
  assert.equal(getMerchantBalance(r.merchant.id), 0);
});

test('successful payment credits merchant net and fee income, balanced ledger', async () => {
  const merchant = db.get(`SELECT * FROM merchants WHERE email = 'ama@example.com'`);

  // GHS 100.00 = 10000 pesewas. msisdn ends even -> mock succeeds.
  
  const p = await createPayment(merchant, {
    amount: 10000,
    channel: 'momo',
    provider: 'mtn',
    msisdn: '0240000002',
    reference: 'order-1',
  });
  assert.equal(p.status, 'pending');
  assert.equal(p.fee, 195);  // 1.95% of 10000
  assert.equal(p.net, 9805);

  // Drive the async settlement.
  handlePspCallback(await waitForCallback(p.provider_reference));

  const settled = db.get(`SELECT * FROM payments WHERE id = ?`, [p.id]);
  assert.equal(settled.status, 'succeeded');

  // Merchant got net, fee income got fee.
  assert.equal(getMerchantBalance(merchant.id), 9805);
  assert.equal(getBalance(getSystemAccount('fees_income')), 195);
  // psp_clearing debited the full amount.
  assert.equal(getBalance(getSystemAccount('psp_clearing')), -10000);
});

test('failed payment moves no money', async () => {
  const merchant = db.get(`SELECT * FROM merchants WHERE email = 'ama@example.com'`);
  const balanceBefore = getMerchantBalance(merchant.id);

  // msisdn ends odd -> mock fails.
  
  const p = await createPayment(merchant, {
    amount: 5000,
    channel: 'momo',
    provider: 'mtn',
    msisdn: '0240000001',
    reference: 'order-2',
  });
  handlePspCallback(await waitForCallback(p.provider_reference));

  const settled = db.get(`SELECT * FROM payments WHERE id = ?`, [p.id]);
  assert.equal(settled.status, 'failed');
  assert.equal(getMerchantBalance(merchant.id), balanceBefore); // unchanged
});

test('duplicate callback is idempotent', async () => {
  const merchant = db.get(`SELECT * FROM merchants WHERE email = 'ama@example.com'`);
  
  const p = await createPayment(merchant, {
    amount: 2000, channel: 'momo', provider: 'mtn', msisdn: '0240000002', reference: 'order-3',
  });
  const cb = await waitForCallback(p.provider_reference);
  handlePspCallback(cb);
  const after1 = getMerchantBalance(merchant.id);
  handlePspCallback(cb);   // duplicate
  handlePspCallback(cb);   // triple
  const after3 = getMerchantBalance(merchant.id);
  assert.equal(after1, after3, 'balance must not change on duplicate callbacks');
});

test('duplicate reference returns same payment (idempotent create)', async () => {
  const merchant = db.get(`SELECT * FROM merchants WHERE email = 'ama@example.com'`);
  
  const a = await createPayment(merchant, {
    amount: 3000, channel: 'momo', provider: 'mtn', msisdn: '0240000002', reference: 'order-dupe',
  });
  
  const b = await createPayment(merchant, {
    amount: 3000, channel: 'momo', provider: 'mtn', msisdn: '0240000002', reference: 'order-dupe',
  });
  assert.equal(a.id, b.id);
});

test('refund reverses merchant balance and fee proportionally', async () => {
  const merchant = db.get(`SELECT * FROM merchants WHERE email = 'ama@example.com'`);
  
  const p = await createPayment(merchant, {
    amount: 10000, channel: 'momo', provider: 'mtn', msisdn: '0240000002', reference: 'order-refund',
  });
  handlePspCallback(await waitForCallback(p.provider_reference));
  const balAfterPay = getMerchantBalance(merchant.id);

  const refunded = refundPayment(merchant, p.id, 10000); // full refund
  assert.equal(refunded.status, 'refunded');
  assert.equal(getMerchantBalance(merchant.id), balAfterPay - 9805);
});

test('GLOBAL LEDGER INVARIANT: all postings sum to zero', () => {
  const total = db.get(`SELECT COALESCE(SUM(amount),0) s FROM postings`).s;
  assert.equal(total, 0, 'the sum of every posting in the system must be zero');
});

test('cached balances reconcile with raw postings', () => {
  const accounts = db.query(`SELECT id FROM ledger_accounts`).rows;
  for (const a of accounts) {
    const r = reconcileAccount(a.id);
    assert.ok(r.ok, `account ${a.id} drifted: summed=${r.summed} cached=${r.cached}`);
  }
});
