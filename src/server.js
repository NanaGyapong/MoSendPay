import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config/index.js';
import { migrate } from './db/migrate.js';
import { router } from './routes/index.js';
import { errorHandler } from './middleware/index.js';
import { logger } from './lib/util.js';
import { ensureSystemAccounts } from './modules/ledger/ledger.service.js';
import { initPsp } from './modules/payments/psp.js';
import { handlePspCallback } from './modules/payments/payment.service.js';
import { processPendingWebhooks } from './modules/webhooks/webhook.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildApp() {
  // Ensure schema + system accounts exist.
  migrate();
  ensureSystemAccounts('GHS');

  // Wire the PSP so its async callbacks settle payments directly in-process.
  // (In production the provider would POST to /v1/webhooks/psp over HTTP instead.)
  initPsp({
    onCallback: async (cb) => {
      handlePspCallback(cb);
    },
  });

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

  // Serve the hosted checkout page for any /checkout/:id URL.
  app.get('/checkout/:id', (_req, res) => {
    res.sendFile(join(__dirname, '..', 'web', 'checkout.html'));
  });

  // Serve the merchant dashboard.
  app.get('/dashboard', (_req, res) => {
    res.sendFile(join(__dirname, '..', 'web', 'dashboard.html'));
  });

  // Friendly landing page at root.
  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MosendPay</title><style>
body{margin:0;background:#0E1116;color:#E8EAED;font-family:system-ui,sans-serif;
min-height:100vh;display:grid;place-items:center;text-align:center}
.dot{width:64px;height:64px;border-radius:16px;background:linear-gradient(135deg,#E8B43C,#A8821F);
display:grid;place-items:center;color:#0E1116;font-weight:800;font-size:34px;margin:0 auto 20px;
font-family:monospace}
a{display:inline-block;margin:8px;padding:12px 22px;border-radius:10px;background:#E8B43C;
color:#0E1116;text-decoration:none;font-weight:600}
a.ghost{background:#161B22;color:#E8EAED;border:1px solid #2A3340}
p{color:#9AA4B2;max-width:440px;margin:0 auto 28px;line-height:1.6}
small{color:#6B7585;display:block;margin-top:30px}
</style></head><body><div>
<div class="dot">M</div>
<h1>MosendPay</h1>
<p>Merchant payments for Ghana — Mobile Money, cards, and a hosted checkout, on a double-entry ledger.</p>
<a href="/dashboard">Merchant Dashboard</a>
<a class="ghost" href="/health">API Health</a>
<small>Demo environment · built on licensed PSP rails</small>
</div></body></html>`);
  });

  app.use(router);
  app.use(errorHandler);
  return app;
}

// Start server + a lightweight in-process webhook loop.
// Always starts when this file is the entrypoint (works on Windows, Linux, Render).
const app = buildApp();
app.listen(config.port, () => {
  logger.info(`MosendPay API listening on :${config.port} (env=${config.env})`);
});

// Deliver webhooks every few seconds in-process.
// At scale this becomes a separate worker fleet (src/worker.js).
setInterval(() => {
  processPendingWebhooks().catch((e) => logger.error({ err: String(e) }, 'webhook loop error'));
}, 3000);
