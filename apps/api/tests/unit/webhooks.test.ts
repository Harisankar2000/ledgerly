import { describe, expect, it } from 'vitest';
import { retryDelaySeconds } from '../../src/workers/webhook-dispatcher.js';
import {
  generateWebhookSecret,
  signPayload,
  verifySignature,
} from '../../src/workers/webhook-signature.js';

describe('webhook signatures', () => {
  const secret = generateWebhookSecret();
  const body = JSON.stringify({ id: 'evt_1', type: 'transaction.posted' });
  const now = Date.UTC(2026, 0, 1);
  const timestamp = Math.floor(now / 1000);

  it('verifies a signature it produced', () => {
    expect(verifySignature(secret, body, signPayload(secret, body, timestamp), { now })).toBe(true);
  });

  it('rejects a tampered body, the wrong secret and a missing header', () => {
    const header = signPayload(secret, body, timestamp);
    expect(verifySignature(secret, `${body} `, header, { now })).toBe(false);
    expect(verifySignature(generateWebhookSecret(), body, header, { now })).toBe(false);
    expect(verifySignature(secret, body, undefined, { now })).toBe(false);
    expect(verifySignature(secret, body, 't=abc,v1=zz', { now })).toBe(false);
  });

  it('rejects signatures outside the replay tolerance window', () => {
    const header = signPayload(secret, body, timestamp - 301);
    expect(verifySignature(secret, body, header, { now })).toBe(false);
    expect(verifySignature(secret, body, header, { now, toleranceSeconds: 600 })).toBe(true);
  });

  it('generates distinct, prefixed secrets', () => {
    expect(generateWebhookSecret()).toMatch(/^whsec_[\w-]{32}$/);
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());
  });
});

describe('retryDelaySeconds', () => {
  it('doubles per attempt and stays within ±20% jitter', () => {
    expect(retryDelaySeconds(1, () => 0.5)).toBe(5);
    expect(retryDelaySeconds(2, () => 0.5)).toBe(10);
    expect(retryDelaySeconds(4, () => 0.5)).toBe(40);
    expect(retryDelaySeconds(1, () => 0)).toBe(4);
    expect(retryDelaySeconds(1, () => 1)).toBe(6);
  });

  it('caps at one hour', () => {
    expect(retryDelaySeconds(30, () => 0.5)).toBe(3600);
  });
});
