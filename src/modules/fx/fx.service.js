// FX (foreign exchange) service for cross-border / remittance flows.
//
// Model (standard remittance pattern):
//   - A sender pays in a SOURCE currency (e.g. GBP, USD, EUR).
//   - We convert to the RECIPIENT currency (GHS) at a quoted rate.
//   - We apply a spread (our margin) on top of the mid-market rate.
//   - The rate is LOCKED at quote time and stored on the transaction, so the
//     amount the recipient gets is fixed even if the market moves.
//
// The ledger stays in GHS (the recipient currency). Conversion happens at the
// edge, here — so the tested single-currency ledger invariant is untouched.
//
// Rates come from a pluggable provider. The default 'mock' provider uses seeded
// mid-market rates so everything runs and tests deterministically. A real
// provider (e.g. a rates API) implements the same getMidRate() interface later.

import { id } from '../../lib/util.js';

const SUPPORTED = ['GHS', 'USD', 'GBP', 'EUR', 'NGN'];

// Seeded mid-market rates: how many GHS per 1 unit of the source currency.
// (Illustrative values; a real provider returns live rates.)
const MOCK_MID_RATES_TO_GHS = {
  GHS: 1,
  USD: 15.5,
  GBP: 19.7,
  EUR: 16.8,
  NGN: 0.0098,
};

// Our spread (margin) in basis points applied to the mid rate. 150 = 1.5%.
const FX_SPREAD_BPS = parseInt(process.env.FX_SPREAD_BPS || '150', 10);

function mockGetMidRate(from, to) {
  if (!MOCK_MID_RATES_TO_GHS[from] || !MOCK_MID_RATES_TO_GHS[to]) {
    throw new Error(`unsupported currency pair ${from}->${to}`);
  }
  // Convert via GHS as the pivot.
  const fromToGhs = MOCK_MID_RATES_TO_GHS[from];
  const toToGhs = MOCK_MID_RATES_TO_GHS[to];
  return fromToGhs / toToGhs; // units of `to` per 1 unit of `from`
}

let provider = { name: 'mock', getMidRate: mockGetMidRate };

export function initFx(custom) {
  if (custom && typeof custom.getMidRate === 'function') provider = custom;
  return provider;
}

export function isSupported(cur) {
  return SUPPORTED.includes(cur);
}

/**
 * Produce a locked quote to convert `amountMinor` (smallest unit of `from`)
 * into `to`. Returns the rate applied (after spread), the converted amount in
 * the recipient's minor units, and a quote id + expiry.
 *
 * Example: 100.00 GBP -> GHS. mid ~19.7, minus 1.5% spread -> recipient gets
 * the spread-adjusted amount; the platform earns the spread.
 */
export function quote({ from, to, amountMinor }) {
  if (!isSupported(from) || !isSupported(to)) {
    throw new Error(`unsupported currency pair ${from}->${to}`);
  }
  const mid = provider.getMidRate(from, to);
  // Apply spread AGAINST the customer: they receive slightly less `to` per `from`.
  const rate = mid * (1 - FX_SPREAD_BPS / 10000);
  // amountMinor is in `from` minor units (e.g. pence). Convert to `to` minor units.
  // Both currencies here use 2 decimal places (minor = major*100), except we keep
  // it general by working in major units for the multiply then back to minor.
  const amountMajor = amountMinor / 100;
  const recipientMajor = amountMajor * rate;
  const recipientMinor = Math.round(recipientMajor * 100);

  // The spread earned, expressed in recipient minor units, for the record.
  const midRecipientMinor = Math.round(amountMajor * mid * 100);
  const spreadMinor = midRecipientMinor - recipientMinor;

  return {
    quoteId: id('fxq'),
    from,
    to,
    midRate: Number(mid.toFixed(6)),
    rate: Number(rate.toFixed(6)),
    spreadBps: FX_SPREAD_BPS,
    sourceAmountMinor: amountMinor,
    recipientAmountMinor: recipientMinor,
    spreadRecipientMinor: spreadMinor,
    // Lock window: a real quote expires; downstream must use it before then.
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
}

export const fxConfig = { SUPPORTED, FX_SPREAD_BPS };
