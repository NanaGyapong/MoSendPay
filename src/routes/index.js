import { Router } from 'express';
import { asyncH, apiKeyAuth, jwtAuth, rateLimit } from '../middleware/index.js';
import { parse, signupSchema, loginSchema, createPaymentSchema, refundSchema } from './schemas.js';
import { signup, login } from '../modules/auth/auth.service.js';
import {
  createPayment,
  getPayment,
  listPayments,
  refundPayment,
  handlePspCallback,
} from '../modules/payments/payment.service.js';
import { getMerchantBalance } from '../modules/ledger/ledger.service.js';
import {
  createCheckoutSession,
  publicSession,
  paySession,
  refreshSession,
} from '../modules/checkout/checkout.service.js';
import { assessRisk } from '../modules/fraud/fraud.service.js';
import { toPesewas, toGhs, badRequest } from '../lib/util.js';
import { db } from '../db/index.js';

export const router = Router();

// ── Health ────────────────────────────────────────────────────────────────────
router.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── Auth (dashboard) ───────────────────────────────────────────────────────────
router.post(
  '/v1/auth/signup',
  asyncH(async (req, res) => {
    const data = parse(signupSchema, req.body);
    const result = await signup(data);
    res.status(201).json(result);
  })
);

router.post(
  '/v1/auth/login',
  asyncH(async (req, res) => {
    const data = parse(loginSchema, req.body);
    res.json(await login(data));
  })
);

// ── Dashboard (JWT) ──────────────────────────────────────────────────────────
router.get(
  '/v1/me',
  jwtAuth,
  asyncH(async (req, res) => {
    const balance = getMerchantBalance(req.merchant.id, req.merchant.currency);
    res.json({
      merchant: {
        id: req.merchant.id,
        businessName: req.merchant.business_name,
        email: req.merchant.email,
        feeBps: req.merchant.fee_bps,
        currency: req.merchant.currency,
      },
      balance: { pesewas: balance, ghs: toGhs(balance) },
    });
  })
);

router.get(
  '/v1/dashboard/payments',
  jwtAuth,
  asyncH(async (req, res) => {
    const payments = listPayments(req.merchant.id, { status: req.query.status, limit: 100 });
    res.json({ data: payments.map(serializePayment) });
  })
);

router.get(
  '/v1/dashboard/stats',
  jwtAuth,
  asyncH(async (req, res) => {
    const mid = req.merchant.id;
    const succeeded = db.get(
      `SELECT COUNT(*) c, COALESCE(SUM(net),0) v FROM payments WHERE merchant_id = ? AND status = 'succeeded'`,
      [mid]
    );
    const all = db.get(`SELECT COUNT(*) c FROM payments WHERE merchant_id = ?`, [mid]);
    const fees = db.get(
      `SELECT COALESCE(SUM(fee),0) v FROM payments WHERE merchant_id = ? AND status = 'succeeded'`,
      [mid]
    );
    const balance = getMerchantBalance(mid, req.merchant.currency);
    res.json({
      totalPayments: all.c,
      succeededPayments: succeeded.c,
      netVolumePesewas: succeeded.v,
      netVolumeGhs: toGhs(succeeded.v),
      feesPaidGhs: toGhs(fees.v),
      availableBalanceGhs: toGhs(balance),
    });
  })
);

// ── Public merchant API (API key) ────────────────────────────────────────────
router.post(
  '/v1/payments',
  apiKeyAuth,
  rateLimit({ max: 120 }),
  asyncH(async (req, res) => {
    const data = parse(createPaymentSchema, req.body);
    const amount = data.amount_pesewas ?? toPesewas(data.amount);
    const payment = await createPayment(req.merchant, {
      amount,
      channel: data.channel,
      provider: data.provider,
      msisdn: data.msisdn,
      email: data.email,
      reference: data.reference,
      description: data.description,
      metadata: data.metadata,
    });
    res.status(201).json(serializePayment(payment));
  })
);

router.get(
  '/v1/payments/:id',
  apiKeyAuth,
  asyncH(async (req, res) => {
    const payment = getPayment(req.merchant.id, req.params.id);
    if (!payment) return res.status(404).json({ error: { code: 'not_found', message: 'payment not found' } });
    res.json(serializePayment(payment));
  })
);

router.get(
  '/v1/payments',
  apiKeyAuth,
  asyncH(async (req, res) => {
    const payments = listPayments(req.merchant.id, { status: req.query.status, limit: 100 });
    res.json({ data: payments.map(serializePayment) });
  })
);

router.post(
  '/v1/payments/:id/refund',
  apiKeyAuth,
  asyncH(async (req, res) => {
    const data = parse(refundSchema, req.body || {});
    const amt = data.amount_pesewas ?? (data.amount != null ? toPesewas(data.amount) : undefined);
    const payment = refundPayment(req.merchant, req.params.id, amt);
    res.json(serializePayment(payment));
  })
);

// ── PSP callback (internal/simulated; in prod secured by provider signature) ──
router.post(
  '/v1/webhooks/psp',
  asyncH(async (req, res) => {
    const { providerReference, status, failureReason } = req.body;
    if (!providerReference || !status) throw badRequest('providerReference and status required');
    const payment = handlePspCallback({ providerReference, status, failureReason });
    res.json(serializePayment(payment));
  })
);

// ── Checkout sessions ────────────────────────────────────────────────────────
// Merchant creates a session server-side (secret key). Returns a public URL.
router.post(
  '/v1/checkout/sessions',
  apiKeyAuth,
  asyncH(async (req, res) => {
    const { amount, amount_pesewas, reference, description, success_url } = req.body || {};
    const amt = amount_pesewas ?? (amount != null ? toPesewas(amount) : null);
    if (!amt) throw badRequest('amount or amount_pesewas required');
    const session = createCheckoutSession(req.merchant, {
      amount: amt,
      reference,
      description,
      successUrl: success_url,
    });
    const base = `${req.protocol}://${req.get('host')}`;
    res.status(201).json({
      id: session.id,
      url: `${base}/checkout/${session.id}`,
      amount_ghs: toGhs(session.amount),
      status: session.status,
      expires_at: session.expires_at,
    });
  })
);

// Public: session details for the hosted page (no auth).
router.get(
  '/v1/checkout/sessions/:id',
  asyncH(async (req, res) => res.json(publicSession(req.params.id)))
);

// Public: customer submits payment from the hosted page (no auth).
router.post(
  '/v1/checkout/sessions/:id/pay',
  rateLimit({ max: 30 }),
  asyncH(async (req, res) => {
    const { msisdn, provider } = req.body || {};
    const result = await paySession(req.params.id, { msisdn, provider });
    res.json(result);
  })
);

// Public: poll settlement status.
router.get(
  '/v1/checkout/sessions/:id/status',
  asyncH(async (req, res) => res.json(refreshSession(req.params.id)))
);

// ── Fraud preview (merchant can test scoring without charging) ────────────────
router.post(
  '/v1/fraud/assess',
  apiKeyAuth,
  asyncH(async (req, res) => {
    const { amount, amount_pesewas, msisdn, channel } = req.body || {};
    const amt = amount_pesewas ?? (amount != null ? toPesewas(amount) : 0);
    res.json(
      assessRisk({
        merchantId: req.merchant.id,
        amount: amt,
        msisdn,
        channel: channel || 'momo',
      })
    );
  })
);

function serializePayment(p) {
  return {
    id: p.id,
    amount_pesewas: p.amount,
    amount_ghs: toGhs(p.amount),
    fee_ghs: toGhs(p.fee),
    net_ghs: toGhs(p.net),
    currency: p.currency,
    channel: p.channel,
    provider: p.provider,
    reference: p.reference,
    description: p.description,
    status: p.status,
    customer_msisdn: p.customer_msisdn,
    refunded_amount_ghs: toGhs(p.refunded_amount),
    metadata: p.metadata,
    created_at: p.created_at,
  };
}
