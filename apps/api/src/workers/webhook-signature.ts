import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'ledgerly-signature';
const DEFAULT_TOLERANCE_SECONDS = 300;

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

function hmac(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * Stripe-style signature: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`.
 * Signing the timestamp lets receivers reject replayed requests.
 */
export function signPayload(
  secret: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  return `t=${timestamp},v1=${hmac(secret, timestamp, body)}`;
}

export function verifySignature(
  secret: string,
  body: string,
  header: string | undefined,
  { toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, now = Date.now() } = {},
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((part) => part.split('=', 2) as [string, string]),
  );
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !parts.v1) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;

  const expected = Buffer.from(hmac(secret, timestamp, body), 'hex');
  const received = Buffer.from(parts.v1, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
