// Checkout sessions.
//
// Flow:
//  1. Merchant (server-side, with secret key) creates a session → gets a URL.
//  2. Customer opens the hosted page at that URL (public; no API key in browser).
//  3. Customer enters their MoMo number and pays → we create a real payment,
//     which runs through fraud scoring + the PSP like any other charge.
//  4. The page polls the public status endpoint until the payment settles.
//
// The session id (cs_...) is public and safe to put in a URL. It carries no
// authority beyond paying the specific amount the merchant fixed.

import { db } from '../../db/index.js';
import { id, notFound, badRequest, conflict, toGhs } from '../../lib/util.js';
import { createPayment, getPayment } from '../payments/payment.service.js';

const SESSION_TTL_MIN = 30;

export function createCheckoutSession(merchant, { amount, reference, description, successUrl }) {
  if (!amount || amount <= 0) throw badRequest('amount must be positive');
  if (!reference) throw badRequest('reference required');
  const sessionId = id('cs');
  db.run(
    `INSERT INTO checkout_sessions
      (id, merchant_id, amount, currency, reference, description, success_url, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`,
    [
      sessionId, merchant.id, amount, merchant.currency, reference,
      description || null, successUrl || null, `+${SESSION_TTL_MIN} minutes`,
    ]
  );
  return getSession(sessionId);
}

export function getSession(sessionId) {
  const s = db.get(`SELECT * FROM checkout_sessions WHERE id = ?`, [sessionId]);
  if (!s) throw notFound('checkout session not found');
  return s;
}

/** Public view of a session — safe to expose to the customer's browser. */
export function publicSession(sessionId) {
  const s = getSession(sessionId);
  const merchant = db.get(`SELECT business_name, currency FROM merchants WHERE id = ?`, [
    s.merchant_id,
  ]);
  let paymentStatus = null;
  if (s.payment_id) {
    const p = db.get(`SELECT status FROM payments WHERE id = ?`, [s.payment_id]);
    paymentStatus = p ? p.status : null;
  }
  return {
    id: s.id,
    businessName: merchant?.business_name,
    amount_ghs: toGhs(s.amount),
    currency: s.currency,
    description: s.description,
    status: s.status,
    paymentStatus,
    success_url: s.success_url,
    expired: new Date(s.expires_at + 'Z') < new Date(),
  };
}

/**
 * Customer pays a session. Creates a real payment (fraud + PSP apply) and links
 * it to the session. Idempotent: paying an already-completed session returns the
 * existing payment status.
 */
export async function paySession(sessionId, { msisdn, provider }) {
  const s = getSession(sessionId);
  if (s.status === 'completed') {
    return { sessionId, paymentId: s.payment_id, status: 'completed' };
  }
  if (new Date(s.expires_at + 'Z') < new Date()) {
    db.run(`UPDATE checkout_sessions SET status = 'expired' WHERE id = ?`, [sessionId]);
    throw conflict('checkout session expired');
  }
  if (!msisdn) throw badRequest('msisdn required');

  const merchant = db.get(`SELECT * FROM merchants WHERE id = ?`, [s.merchant_id]);

  // Reference ties the payment to the session; unique per session so retries
  // from the page are idempotent at the payment layer.
  const payment = await createPayment(merchant, {
    amount: s.amount,
    channel: 'momo',
    provider: provider || 'mtn',
    msisdn,
    reference: `cs_${s.id}`,
    description: s.description || 'Checkout payment',
    metadata: { checkout_session: s.id },
  });

  db.run(`UPDATE checkout_sessions SET payment_id = ? WHERE id = ?`, [payment.id, sessionId]);
  if (payment.status === 'succeeded') {
    db.run(`UPDATE checkout_sessions SET status = 'completed' WHERE id = ?`, [sessionId]);
  }
  return { sessionId, paymentId: payment.id, status: payment.status };
}

/** Called by the status poll — reflects settlement back onto the session. */
export function refreshSession(sessionId) {
  const s = getSession(sessionId);
  if (s.payment_id && s.status !== 'completed') {
    const p = db.get(`SELECT status FROM payments WHERE id = ?`, [s.payment_id]);
    if (p && p.status === 'succeeded') {
      db.run(`UPDATE checkout_sessions SET status = 'completed' WHERE id = ?`, [sessionId]);
    }
  }
  return publicSession(sessionId);
}
