// Auth + merchant onboarding.
// - Sign up creates a merchant, an owner user, a ledger account, and a first API key.
// - Login issues a short-lived JWT for the dashboard.
// - API keys: public key is safe to expose; the secret is shown ONCE and only its
//   bcrypt hash is stored.

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../../db/index.js';
import { config } from '../../config/index.js';
import { id, ApiError, badRequest, unauthorized, conflict } from '../../lib/util.js';
import { ensureMerchantAccount } from '../ledger/ledger.service.js';

function newApiKeySecrets() {
  // public key is informational; secret is the bearer credential.
  const pub = `pk_live_${id('').split('_')[1].slice(0, 24)}`;
  const secret = `sk_live_${id('').split('_')[1]}`;
  const webhookSecret = `whsec_${id('').split('_')[1]}`;
  return { pub, secret, webhookSecret };
}

export async function signup({ businessName, email, password }) {
  if (!businessName || !email || !password) throw badRequest('missing fields');
  if (password.length < 8) throw badRequest('password must be at least 8 characters');

  const exists = db.get(`SELECT id FROM merchants WHERE email = ?`, [email]);
  if (exists) throw conflict('a merchant with this email already exists');

  const merchantId = id('mrch');
  const userId = id('usr');
  const keyId = id('key');
  const passwordHash = await bcrypt.hash(password, 10);
  const { pub, secret, webhookSecret } = newApiKeySecrets();
  const secretHash = await bcrypt.hash(secret, 10);

  db.tx(() => {
    db.run(
      `INSERT INTO merchants (id, business_name, email, fee_bps) VALUES (?, ?, ?, ?)`,
      [merchantId, businessName, email, config.defaultFeeBps]
    );
    db.run(
      `INSERT INTO users (id, merchant_id, email, password_hash, role) VALUES (?, ?, ?, ?, 'owner')`,
      [userId, merchantId, email, passwordHash]
    );
    db.run(
      `INSERT INTO api_keys (id, merchant_id, public_key, secret_hash, secret_last4, webhook_secret)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [keyId, merchantId, pub, secretHash, secret.slice(-4), webhookSecret]
    );
    ensureMerchantAccount(merchantId, 'GHS');
  });

  const token = signToken({ userId, merchantId });
  // secret returned ONCE here — never retrievable again.
  return {
    token,
    merchant: { id: merchantId, businessName, email },
    apiKey: { id: keyId, publicKey: pub, secretKey: secret, webhookSecret },
  };
}

export async function login({ email, password }) {
  const user = db.get(`SELECT * FROM users WHERE email = ?`, [email]);
  if (!user) throw unauthorized('invalid credentials');
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw unauthorized('invalid credentials');
  const token = signToken({ userId: user.id, merchantId: user.merchant_id });
  const merchant = db.get(`SELECT id, business_name, email FROM merchants WHERE id = ?`, [
    user.merchant_id,
  ]);
  return { token, merchant };
}

export function signToken(payload) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtAccessTtl });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    throw unauthorized('invalid or expired token');
  }
}

/** Look up a merchant by API secret key (for API auth). */
export async function authenticateApiKey(secretKey) {
  if (!secretKey || !secretKey.startsWith('sk_')) throw unauthorized('invalid api key');
  // We must compare against every active key's hash. In production, index by a
  // fast prefix or store a deterministic lookup hash; for the MVP we scan active keys.
  const keys = db.query(`SELECT * FROM api_keys WHERE status = 'active'`).rows;
  for (const k of keys) {
    if (await bcrypt.compare(secretKey, k.secret_hash)) {
      const merchant = db.get(`SELECT * FROM merchants WHERE id = ?`, [k.merchant_id]);
      if (!merchant || merchant.status !== 'active') throw unauthorized('merchant inactive');
      return { merchant, apiKey: k };
    }
  }
  throw unauthorized('invalid api key');
}
