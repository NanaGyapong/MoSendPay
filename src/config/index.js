// Centralised config. In production these come from environment variables /
// secrets manager. Sensible local defaults keep the MVP runnable out of the box.

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),

  // DB: if DATABASE_URL is set we'd use Postgres (see db/index.js). Otherwise
  // we fall back to a local SQLite file so the project runs with zero infra.
  databaseUrl: process.env.DATABASE_URL || null,
  sqlitePath: process.env.SQLITE_PATH || './mosendpay.db',

  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  jwtAccessTtl: process.env.JWT_ACCESS_TTL || '15m',

  // Platform default merchant fee (basis points). 195 = 1.95%.
  defaultFeeBps: parseInt(process.env.DEFAULT_FEE_BPS || '195', 10),

  // PSP provider: 'mock' simulates rails locally. Swap for 'hubtel' | 'paystack'
  // once you have a licensed partner.
  pspProvider: process.env.PSP_PROVIDER || 'mock',

  // How long the mock provider waits before firing its async callback (ms).
  mockCallbackDelayMs: parseInt(process.env.MOCK_CALLBACK_DELAY_MS || '1500', 10),
};
