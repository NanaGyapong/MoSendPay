// Fraud scoring engine.
//
// Real-time risk scoring before a charge is initiated, mirroring the
// "Fraud Detection System" design: extract signals, score each, combine into a
// 0–100 risk score, then decide allow / review / block.
//
// This MVP uses a transparent rules engine (no ML dependency) so every score is
// explainable — which is what you want early, both for debugging and for the
// compliance/audit trail. The interface is shaped so a trained model can later
// replace or augment `scoreSignals` without touching the callers.
//
// Decision bands (matching the slide): score < 30 allow, 30–79 review, ≥ 80 block.

import { db } from '../../db/index.js';

const ALLOW_BELOW = 30;
const BLOCK_AT = 80;

/**
 * Compute a risk assessment for a prospective payment.
 * @returns {{score:number, decision:'allow'|'review'|'block', reasons:string[]}}
 */
export function assessRisk({ merchantId, amount, msisdn, channel, customerEmail }) {
  const reasons = [];
  let score = 0;

  // ── Signal 1: Velocity — too many attempts from the same payer recently. ──
  if (msisdn) {
    const recent = db.get(
      `SELECT COUNT(*) c FROM payments
        WHERE customer_msisdn = ? AND created_at >= datetime('now','-10 minutes')`,
      [msisdn]
    ).c;
    if (recent >= 5) { score += 45; reasons.push(`velocity: ${recent} attempts in 10 min`); }
    else if (recent >= 3) { score += 25; reasons.push(`velocity: ${recent} attempts in 10 min`); }
  }

  // ── Signal 2: Amount anomaly — far above this merchant's typical charge. ──
  const stats = db.get(
    `SELECT COUNT(*) n, COALESCE(AVG(amount),0) avg FROM payments
      WHERE merchant_id = ? AND status = 'succeeded'`,
    [merchantId]
  );
  if (stats.n >= 5 && stats.avg > 0 && amount > stats.avg * 10) {
    score += 30;
    reasons.push(`amount ${(amount / stats.avg).toFixed(1)}x merchant average`);
  }

  // ── Signal 3: Large absolute amount (hard ceiling heuristic). ──
  // GHS 10,000 = 1,000,000 pesewas. Big-ticket charges get extra scrutiny.
  if (amount >= 1_000_000) { score += 20; reasons.push('large absolute amount'); }

  // ── Signal 4: Repeated recent failures from this payer (card-testing-like). ──
  if (msisdn) {
    const fails = db.get(
      `SELECT COUNT(*) c FROM payments
        WHERE customer_msisdn = ? AND status = 'failed'
          AND created_at >= datetime('now','-1 hour')`,
      [msisdn]
    ).c;
    if (fails >= 3) { score += 25; reasons.push(`${fails} failed attempts in last hour`); }
  }

  // ── Signal 5: Malformed / suspicious MoMo number for momo channel. ──
  if (channel === 'momo' && msisdn && !/^0\d{9}$/.test(msisdn.replace(/\s+/g, ''))) {
    score += 15;
    reasons.push('msisdn format unusual');
  }

  score = Math.min(score, 100);
  const decision = score >= BLOCK_AT ? 'block' : score >= ALLOW_BELOW ? 'review' : 'allow';
  if (reasons.length === 0) reasons.push('no risk signals');

  return { score, decision, reasons };
}

export const fraudConfig = { ALLOW_BELOW, BLOCK_AT };
