import { authenticateApiKey, verifyToken } from '../modules/auth/auth.service.js';
import { db } from '../db/index.js';
import { ApiError, unauthorized, logger } from '../lib/util.js';

/** Wrap async route handlers so thrown errors hit the error middleware. */
export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** API-key auth for the public merchant API (Authorization: Bearer sk_live_...). */
export const apiKeyAuth = asyncH(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const { merchant, apiKey } = await authenticateApiKey(token);
  req.merchant = merchant;
  req.apiKey = apiKey;
  next();
});

/** JWT auth for the dashboard. */
export const jwtAuth = asyncH(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized('missing token');
  const claims = verifyToken(token);
  const merchant = db.get(`SELECT * FROM merchants WHERE id = ?`, [claims.merchantId]);
  if (!merchant) throw unauthorized('merchant not found');
  req.merchant = merchant;
  req.user = claims;
  next();
});

/**
 * Simple per-key sliding-window rate limiter (in-memory for the MVP; Redis in
 * production). Keyed by merchant id or IP.
 */
const buckets = new Map();
export function rateLimit({ windowMs = 60_000, max = 120 } = {}) {
  return (req, res, next) => {
    const key = req.merchant?.id || req.ip;
    const now = Date.now();
    const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      res.set('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: { code: 'rate_limited', message: 'too many requests' } });
    }
    arr.push(now);
    buckets.set(key, arr);
    next();
  };
}

/** Final error handler — turns ApiError (and unknown errors) into JSON. */
export function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) {
    return res
      .status(err.status)
      .json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  // Unique-constraint and other DB errors → 409/400 where sensible.
  if (String(err.message || '').includes('UNIQUE constraint')) {
    return res
      .status(409)
      .json({ error: { code: 'conflict', message: 'resource already exists' } });
  }
  logger.error({ err: String(err.stack || err) }, 'unhandled error');
  res.status(500).json({ error: { code: 'internal_error', message: 'something went wrong' } });
}
