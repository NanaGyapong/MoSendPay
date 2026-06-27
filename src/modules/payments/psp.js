// PSP (Payment Service Provider) abstraction.
//
// In production MosendPay rides on a licensed partner's rails (Hubtel, Paystack,
// Flutterwave, ...). Each integration implements this interface. The rest of the
// app only knows the interface, so adding a provider is a new file + config flag,
// never a rewrite.
//
// Contract:
//   charge({ paymentId, amount, currency, channel, provider, msisdn })
//     -> { providerReference }  (synchronously accepted; settlement is async)
//
// The provider later calls back to /webhooks/psp with the final status, which is
// how real MoMo works: you initiate, the customer approves on their phone, then
// the network notifies you.

import { config } from '../../config/index.js';
import { id, logger } from '../../lib/util.js';

/**
 * Mock provider: accepts the charge, then after a delay fires an internal
 * callback simulating the network's async result. Phone numbers ending in an
 * even digit succeed; odd digit fail — handy for deterministic testing.
 */
function createMockProvider({ onCallback }) {
  return {
    name: 'mock',
    async charge({ paymentId, amount, currency, channel, provider, msisdn }) {
      const providerReference = id('psp');
      logger.info({ paymentId, providerReference }, 'mock PSP accepted charge');

      // Simulate async settlement without blocking the request.
      setTimeout(() => {
        const lastDigit = (msisdn || '0').replace(/\D/g, '').slice(-1) || '0';
        const succeed = Number(lastDigit) % 2 === 0;
        onCallback({
          providerReference,
          status: succeed ? 'succeeded' : 'failed',
          failureReason: succeed ? null : 'insufficient_funds',
        }).catch((e) => logger.error({ err: e }, 'mock callback failed'));
      }, config.mockCallbackDelayMs);

      return { providerReference };
    },
  };
}

let provider;

/** Initialise the configured provider. onCallback handles async settlement. */
export function initPsp({ onCallback }) {
  switch (config.pspProvider) {
    case 'mock':
      provider = createMockProvider({ onCallback });
      break;
    // case 'hubtel':   provider = createHubtelProvider({ onCallback }); break;
    // case 'paystack': provider = createPaystackProvider({ onCallback }); break;
    default:
      throw new Error(`unknown PSP provider: ${config.pspProvider}`);
  }
  logger.info({ provider: provider.name }, 'PSP provider initialised');
  return provider;
}

export function getPsp() {
  if (!provider) throw new Error('PSP not initialised — call initPsp() at startup');
  return provider;
}
