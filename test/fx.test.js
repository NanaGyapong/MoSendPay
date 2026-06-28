// FX service tests. Run: node --test-concurrency=1 test/fx.test.js

import assert from 'node:assert';
import { test } from 'node:test';

const { quote, isSupported, fxConfig } = await import('../src/modules/fx/fx.service.js');

test('supported currencies include GHS, USD, GBP', () => {
  assert.ok(isSupported('GHS'));
  assert.ok(isSupported('USD'));
  assert.ok(isSupported('GBP'));
  assert.ok(!isSupported('XYZ'));
});

test('GBP -> GHS quote applies spread against the customer', () => {
  const q = quote({ from: 'GBP', to: 'GHS', amountMinor: 10000 }); // 100.00 GBP
  // mid ~19.7; rate after 1.5% spread is slightly less
  assert.ok(q.rate < q.midRate, 'rate should be below mid after spread');
  // recipient gets roughly 100 * ~19.4 ≈ 1940 GHS
  assert.ok(q.recipientAmountMinor > 190000 && q.recipientAmountMinor < 200000,
    `unexpected recipient amount ${q.recipientAmountMinor}`);
  // spread is positive (our margin)
  assert.ok(q.spreadRecipientMinor > 0);
});

test('GHS -> GHS is identity (minus spread)', () => {
  const q = quote({ from: 'GHS', to: 'GHS', amountMinor: 10000 });
  assert.ok(Math.abs(q.midRate - 1) < 1e-9);
});

test('unsupported pair throws', () => {
  assert.throws(() => quote({ from: 'XYZ', to: 'GHS', amountMinor: 100 }));
});

test('spread bps is configured', () => {
  assert.ok(fxConfig.FX_SPREAD_BPS >= 0);
});
