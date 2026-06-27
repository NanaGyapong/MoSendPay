// Standalone worker. In production this runs as its own process/fleet, pulling
// jobs from the queue (BullMQ/Redis) for webhook delivery, settlement batches,
// and ledger reconciliation. For the MVP it polls the DB.

import { migrate } from './db/migrate.js';
import { processPendingWebhooks } from './modules/webhooks/webhook.service.js';
import { logger } from './lib/util.js';

migrate();
logger.info('MosendPay worker started');

async function loop() {
  try {
    const n = await processPendingWebhooks();
    if (n) logger.info({ delivered: n }, 'webhooks delivered');
  } catch (e) {
    logger.error({ err: String(e) }, 'worker error');
  }
}

setInterval(loop, 2000);
