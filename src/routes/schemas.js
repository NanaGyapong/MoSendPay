import { z } from 'zod';

export const signupSchema = z.object({
  businessName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const createPaymentSchema = z.object({
  // amount in GHS (decimal) OR amount_pesewas (integer). We normalise in the route.
  amount: z.number().positive().optional(),
  amount_pesewas: z.number().int().positive().optional(),
  channel: z.enum(['momo', 'card']),
  provider: z.enum(['mtn', 'telecel', 'airteltigo', 'card']).optional(),
  msisdn: z.string().min(9).optional(),
  email: z.string().email().optional(),
  reference: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  metadata: z.record(z.any()).optional(),
}).refine((d) => d.amount != null || d.amount_pesewas != null, {
  message: 'amount or amount_pesewas required',
});

export const refundSchema = z.object({
  amount: z.number().positive().optional(),
  amount_pesewas: z.number().int().positive().optional(),
});

export function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    const err = new Error('validation failed');
    err.status = 400;
    err.code = 'validation_error';
    err.details = details;
    throw err;
  }
  return result.data;
}
