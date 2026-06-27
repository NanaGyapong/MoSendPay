// Webhook delivery.
//
// When a payment settles we enqueue an event. The worker delivers it to the
// merchant's webhook_url with an HMAC-SHA256 signature over the raw body, and
// retries with backoff on failure. Merchants verify the signature to trust the
// event came from MosendPay.

import crypto from 'node:crypto';
import { db } from '../../db/index.js';
import { id, logger } from '../../lib/util.js';

/** Record an event to be delivered. Called inside payment flows. */
export function enqueueWebhook(merchantId, type, payload) {
  const evtId = id('evt');
  db.run(
    `INSERT INTO webhook_events (id, merchant_id, type, payload, status, next_retry_at)
     VALUES (?, ?, ?, ?, 'pending', datetime('now'))`,
    [evtId, merchantId, type, JSON.stringify({ id: evtId, type, data: payload })]
  );
  return evtId;
}

export function signPayload(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Deliver pending events whose retry time has passed. Returns count delivered.
 * In production this runs continuously in the worker; for the MVP it can also be
 * invoked on demand. Uses fetch() with a timeout.
 */
export async function processPendingWebhooks({ max = 20 } = {}) {
  const due = db.query(
    `SELECT * FROM webhook_events
      WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
      ORDER BY created_at ASC LIMIT ?`,
    [max]
  ).rows;

  let delivered = 0;
  for (const evt of due) {
    const key = db.get(
      `SELECT webhook_url, webhook_secret FROM api_keys WHERE merchant_id = ? AND status = 'active' LIMIT 1`,
      [evt.merchant_id]
    );

    if (!key || !key.webhook_url) {
      // No endpoint configured — mark delivered (nothing to do) so we don't loop.
      db.run(`UPDATE webhook_events SET status = 'delivered' WHERE id = ?`, [evt.id]);
      continue;
    }

    const signature = signPayload(key.webhook_secret, evt.payload);
    try {
      const res = await fetchWithTimeout(key.webhook_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mosendpay-signature': signature,
          'mosendpay-event-type': evt.type,
        },
        body: evt.payload,
      });
      if (res.ok) {
        db.run(`UPDATE webhook_events SET status = 'delivered', attempts = attempts + 1 WHERE id = ?`, [
          evt.id,
        ]);
        delivered++;
      } else {
        scheduleRetry(evt);
      }
    } catch (err) {
      logger.warn({ err: String(err), evt: evt.id }, 'webhook delivery failed');
      scheduleRetry(evt);
    }
  }
  return delivered;
}

function scheduleRetry(evt) {
  const attempts = evt.attempts + 1;
  if (attempts >= 6) {
    db.run(`UPDATE webhook_events SET status = 'failed', attempts = ? WHERE id = ?`, [
      attempts,
      evt.id,
    ]);
    return;
  }
  // Exponential backoff in minutes: 1,2,4,8,16.
  const backoffMin = Math.pow(2, attempts - 1);
  db.run(
    `UPDATE webhook_events
       SET attempts = ?, next_retry_at = datetime('now', '+' || ? || ' minutes')
     WHERE id = ?`,
    [attempts, backoffMin, evt.id]
  );
}

async function fetchWithTimeout(url, opts, ms = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
