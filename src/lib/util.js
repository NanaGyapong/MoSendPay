import { customAlphabet } from 'nanoid';
import pino from 'pino';

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
const nano = customAlphabet(alphabet, 24);

/** Prefixed, URL-safe id. e.g. id('pay') -> 'pay_3f9k...' */
export function id(prefix) {
  return `${prefix}_${nano()}`;
}

export const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// ── Money ────────────────────────────────────────────────────────────────────
// All amounts are integer pesewas (1 GHS = 100). These helpers are the ONLY
// place money formatting happens, so we never sprinkle float math around.

export function toPesewas(ghs) {
  return Math.round(Number(ghs) * 100);
}
export function toGhs(pesewas) {
  return (pesewas / 100).toFixed(2);
}
/** fee in pesewas given amount + basis points. 195 bps of 10000 = 195. */
export function calcFee(amountPesewas, feeBps) {
  return Math.round((amountPesewas * feeBps) / 10000);
}

// ── Errors ───────────────────────────────────────────────────────────────────
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const badRequest = (msg, details) => new ApiError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Unauthorized') => new ApiError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Forbidden') => new ApiError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found') => new ApiError(404, 'not_found', msg);
export const conflict = (msg, details) => new ApiError(409, 'conflict', msg, details);
