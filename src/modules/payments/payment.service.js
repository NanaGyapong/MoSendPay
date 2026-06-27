// Payments service: create charges, drive the state machine, and write ledger
// postings atomically when a payment settles.

import { db } from '../../db/index.js';
import { id, calcFee, ApiError, badRequest, notFound, conflict, logger } from '../../lib/util.js';
import {
  ensureMerchantAccount,
  getSystemAccount,
  postEntry,
} from '../ledger/ledger.service.js';
import { getPsp } from './psp.js';
import { enqueueWebhook } from '../webhooks/webhook.service.js';
import { assessRisk } from '../fraud/fraud.service.js';

// Legal state transitions. Anything not listed is rejected.
const TRANSITIONS = {
  created: ['pending', 'cancelled'],
  pending: ['processing', 'failed', 'cancelled'],
  processing: ['succeeded', 'failed'],
  succeeded: ['refunded', 'partially_refunded'],
  partially_refunded: ['refunded', 'partially_refunded'],
};

function assertTransition(from, to) {
  if (!TRANSITIONS[from] || !TRANSITIONS[from].includes(to)) {
    throw new ApiError(409, 'invalid_transition', `cannot move payment ${from} -> ${to}`);
  }
}

function rowToPayment(r) {
  if (!r) return null;
  return {
    id: r.id,
    merchant_id: r.merchant_id,
    amount: r.amount,
    fee: r.fee,
    net: r.net,
    currency: r.currency,
    channel: r.channel,
    provider: r.provider,
    customer_msisdn: r.customer_msisdn,
    customer_email: r.customer_email,
    reference: r.reference,
    description: r.description,
    status: r.status,
    provider_reference: r.provider_reference,
    failure_reason: r.failure_reason,
    refunded_amount: r.refunded_amount,
    metadata: JSON.parse(r.metadata || '{}'),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function getPayment(merchantId, paymentId) {
  const r = db.get(`SELECT * FROM payments WHERE id = ? AND merchant_id = ?`, [
    paymentId,
    merchantId,
  ]);
  return rowToPayment(r);
}

export function listPayments(merchantId, { limit = 50, status } = {}) {
  const params = [merchantId];
  let sql = `SELECT * FROM payments WHERE merchant_id = ?`;
  if (status) {
    sql += ` AND status = ?`;
    params.push(status);
  }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(Math.min(limit, 200));
  return db.query(sql, params).rows.map(rowToPayment);
}

/**
 * Create a payment and initiate the charge with the PSP.
 * Idempotency at the reference level: a merchant cannot create two payments with
 * the same `reference` (enforced by a unique index → surfaced as 409).
 */
export async function createPayment(merchant, input) {
  const { amount, channel, provider, msisdn, email, reference, description, metadata } = input;

  if (amount <= 0) throw badRequest('amount must be positive');
  if (channel === 'momo' && !msisdn) throw badRequest('msisdn required for momo');

  const existing = db.get(`SELECT * FROM payments WHERE merchant_id = ? AND reference = ?`, [
    merchant.id,
    reference,
  ]);
  if (existing) {
    // Idempotent create: same reference returns the existing payment.
    return rowToPayment(existing);
  }

  const fee = calcFee(amount, merchant.fee_bps);
  const net = amount - fee;
  const paymentId = id('pay');

  // ── Fraud scoring: assess risk BEFORE initiating the charge. ──
  const risk = assessRisk({
    merchantId: merchant.id,
    amount,
    msisdn,
    channel,
    customerEmail: email,
  });
  const enrichedMetadata = { ...(metadata || {}), risk };

  // High-risk payments are blocked outright and never sent to the PSP.
  if (risk.decision === 'block') {
    db.run(
      `INSERT INTO payments
        (id, merchant_id, amount, fee, net, currency, channel, provider,
         customer_msisdn, customer_email, reference, description, status,
         failure_reason, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?)`,
      [
        paymentId, merchant.id, amount, fee, net, merchant.currency, channel,
        provider || null, msisdn || null, email || null, reference,
        description || null, `blocked: risk ${risk.score}`,
        JSON.stringify(enrichedMetadata),
      ]
    );
    const blocked = getPaymentById(paymentId);
    enqueueWebhook(merchant.id, 'payment.blocked', blocked);
    return blocked;
  }

  db.run(
    `INSERT INTO payments
      (id, merchant_id, amount, fee, net, currency, channel, provider,
       customer_msisdn, customer_email, reference, description, status, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?)`,
    [
      paymentId,
      merchant.id,
      amount,
      fee,
      net,
      merchant.currency,
      channel,
      provider || null,
      msisdn || null,
      email || null,
      reference,
      description || null,
      JSON.stringify(enrichedMetadata),
    ]
  );

  // Initiate with PSP and move to pending.
  const psp = getPsp();
  const { providerReference } = await psp.charge({
    paymentId,
    amount,
    currency: merchant.currency,
    channel,
    provider,
    msisdn,
  });

  db.run(
    `UPDATE payments SET status = 'pending', provider_reference = ?, updated_at = datetime('now') WHERE id = ?`,
    [providerReference, paymentId]
  );

  return getPaymentById(paymentId);
}

function getPaymentById(paymentId) {
  return rowToPayment(db.get(`SELECT * FROM payments WHERE id = ?`, [paymentId]));
}

/**
 * Handle the async PSP callback. Idempotent on provider_reference: duplicate
 * callbacks (which always happen) settle the payment exactly once. On success we
 * write balanced ledger postings inside the same db transaction as the status
 * change — so a payment can never be 'succeeded' without matching postings.
 */
export function handlePspCallback({ providerReference, status, failureReason }) {
  const payment = db.get(`SELECT * FROM payments WHERE provider_reference = ?`, [
    providerReference,
  ]);
  if (!payment) throw notFound('payment for provider_reference not found');

  // Already settled? Idempotent no-op.
  if (['succeeded', 'failed', 'refunded', 'partially_refunded'].includes(payment.status)) {
    logger.info({ paymentId: payment.id }, 'callback ignored — already settled');
    return rowToPayment(payment);
  }

  if (status === 'succeeded') {
    db.tx(() => {
      // pending/processing -> succeeded
      assertTransition(payment.status === 'pending' ? 'pending' : payment.status, 'processing');
      // Move through processing to succeeded for a clean audit trail.
      db.run(`UPDATE payments SET status = 'processing', updated_at = datetime('now') WHERE id = ?`, [
        payment.id,
      ]);

      const merchantAcct = ensureMerchantAccount(payment.merchant_id, payment.currency);
      const pspClearing = getSystemAccount('psp_clearing', payment.currency);
      const feesIncome = getSystemAccount('fees_income', payment.currency);

      // DR psp_clearing (amount), CR merchant_available (net), CR fees_income (fee)
      postEntry({
        kind: 'payment',
        paymentId: payment.id,
        description: `payment ${payment.id}`,
        postings: [
          { accountId: pspClearing, amount: -payment.amount },
          { accountId: merchantAcct, amount: payment.net },
          { accountId: feesIncome, amount: payment.fee },
        ],
      });

      db.run(`UPDATE payments SET status = 'succeeded', updated_at = datetime('now') WHERE id = ?`, [
        payment.id,
      ]);
    });

    enqueueWebhook(payment.merchant_id, 'payment.succeeded', getPaymentById(payment.id));
  } else {
    db.run(
      `UPDATE payments SET status = 'failed', failure_reason = ?, updated_at = datetime('now') WHERE id = ?`,
      [failureReason || 'failed', payment.id]
    );
    enqueueWebhook(payment.merchant_id, 'payment.failed', getPaymentById(payment.id));
  }

  return getPaymentById(payment.id);
}

/**
 * Refund (full or partial). Writes a reversing ledger entry: debit the merchant's
 * available balance and the fee income proportionally, credit psp_clearing.
 */
export function refundPayment(merchant, paymentId, refundAmount) {
  const payment = db.get(`SELECT * FROM payments WHERE id = ? AND merchant_id = ?`, [
    paymentId,
    merchant.id,
  ]);
  if (!payment) throw notFound('payment not found');
  if (!['succeeded', 'partially_refunded'].includes(payment.status)) {
    throw conflict('only succeeded payments can be refunded');
  }
  const remaining = payment.amount - payment.refunded_amount;
  const amt = refundAmount ?? remaining;
  if (amt <= 0 || amt > remaining) throw badRequest('invalid refund amount');

  const feePortion = Math.round((payment.fee * amt) / payment.amount);
  const netPortion = amt - feePortion;

  return db.tx(() => {
    const merchantAcct = ensureMerchantAccount(payment.merchant_id, payment.currency);
    const pspClearing = getSystemAccount('psp_clearing', payment.currency);
    const feesIncome = getSystemAccount('fees_income', payment.currency);

    postEntry({
      kind: 'refund',
      paymentId: payment.id,
      description: `refund ${payment.id}`,
      postings: [
        { accountId: merchantAcct, amount: -netPortion },
        { accountId: feesIncome, amount: -feePortion },
        { accountId: pspClearing, amount: amt },
      ],
    });

    const newRefunded = payment.refunded_amount + amt;
    const newStatus = newRefunded >= payment.amount ? 'refunded' : 'partially_refunded';
    db.run(
      `UPDATE payments SET refunded_amount = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
      [newRefunded, newStatus, payment.id]
    );
    const updated = getPaymentById(payment.id);
    enqueueWebhook(payment.merchant_id, 'payment.refunded', updated);
    return updated;
  });
}
