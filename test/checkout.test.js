// Tests for fraud scoring + checkout session flow.
// Run: node --test-concurrency=1 test/checkout.test.js

import assert from 'node:assert';
import { test } from 'node:test';
import { existsSync, unlinkSync } from 'node:fs';

process.env.SQLITE_PATH = './test-checkout.db';
process.env.MOCK_CALLBACK_DELAY_MS = '10';
if (existsSync('./test-checkout.db')) unlinkSync('./test-checkout.db');

const { migrate } = await import('../src/db/migrate.js');
const { ensureSystemAccounts } = await import('../src/modules/ledger/ledger.service.js');
const { initPsp } = await import('../src/modules/payments/psp.js');
const { handlePspCallback } = await import('../src/modules/payments/payment.service.js');
const { signup } = await import('../src/modules/auth/auth.service.js');
const { assessRisk } = await import('../src/modules/fraud/fraud.service.js');
const { createCheckoutSession, paySession, refreshSession } = await import(
  '../src/modules/checkout/checkout.service.js'
);
const { db } = await import('../src/db/index.js');

migrate();
ensureSystemAccounts('GHS');

const cbBuffer = [];
const cbWaiters = [];
initPsp({
  onCallback: async (cb) => {
    const i = cbWaiters.findIndex((w) => !w.ref || w.ref === cb.providerReference);
    if (i >= 0) cbWaiters.splice(i, 1)[0].resolve(cb);
    else cbBuffer.push(cb);
  },
});
function waitForCallback(ref) {
  const i = cbBuffer.findIndex((cb) => !ref || cb.providerReference === ref);
  if (i >= 0) return Promise.resolve(cbBuffer.splice(i, 1)[0]);
  return new Promise((resolve) => cbWaiters.push({ ref, resolve }));
}

let merchant;
test('setup merchant', async () => {
  const r = await signup({ businessName: 'Esi Mart', email: 'esi@mart.gh', password: 'password123' });
  merchant = db.get(`SELECT * FROM merchants WHERE email = 'esi@mart.gh'`);
  assert.ok(merchant);
});

test('fraud: clean payment scores low and is allowed', () => {
  const r = assessRisk({ merchantId: merchant.id, amount: 10000, msisdn: '0240000002', channel: 'momo' });
  assert.equal(r.decision, 'allow');
  assert.ok(r.score < 30);
});

test('fraud: malformed msisdn adds risk', () => {
  const r = assessRisk({ merchantId: merchant.id, amount: 10000, msisdn: '123', channel: 'momo' });
  assert.ok(r.score >= 15);
});

test('fraud: huge amount is flagged', () => {
  const r = assessRisk({ merchantId: merchant.id, amount: 2_000_000, msisdn: '0240000002', channel: 'momo' });
  assert.ok(r.score >= 20);
  assert.ok(r.reasons.some((x) => x.includes('large')));
});

test('checkout: full happy path settles the session', async () => {
  const session = createCheckoutSession(merchant, {
    amount: 15000, reference: 'cart-77', description: 'Two bags of rice',
  });
  assert.ok(session.id.startsWith('cs_'));
  assert.equal(session.status, 'open');

  const pay = await paySession(session.id, { msisdn: '0240000002', provider: 'mtn' });
  assert.equal(pay.status, 'pending');

  // settle
  const p = db.get(`SELECT provider_reference FROM payments WHERE id = ?`, [pay.paymentId]);
  handlePspCallback(await waitForCallback(p.provider_reference));

  const refreshed = refreshSession(session.id);
  assert.equal(refreshed.status, 'completed');
  assert.equal(refreshed.paymentStatus, 'succeeded');
});

test('checkout: paying a completed session is idempotent', async () => {
  const session = createCheckoutSession(merchant, { amount: 5000, reference: 'cart-78' });
  const p1 = await paySession(session.id, { msisdn: '0240000002' });
  const pr = db.get(`SELECT provider_reference FROM payments WHERE id = ?`, [p1.paymentId]);
  handlePspCallback(await waitForCallback(pr.provider_reference));
  refreshSession(session.id);
  const p2 = await paySession(session.id, { msisdn: '0240000002' });
  assert.equal(p2.status, 'completed');
  assert.equal(p2.paymentId, p1.paymentId);
});

test('global ledger invariant still holds after checkout', () => {
  const total = db.get(`SELECT COALESCE(SUM(amount),0) s FROM postings`).s;
  assert.equal(total, 0);
});
