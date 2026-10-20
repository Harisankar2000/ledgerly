import type { Currency } from '../api/types';

const LOCALE: Record<Currency, string> = { INR: 'en-IN', USD: 'en-US' };

/** 123456 (paise) -> "₹1,234.56". */
export function formatMoney(minor: number, currency: Currency): string {
  return new Intl.NumberFormat(LOCALE[currency], { style: 'currency', currency }).format(
    minor / 100,
  );
}

/** Signed version for statements: "+₹10.00" / "−₹10.00". */
export function formatSigned(minor: number, currency: Currency): string {
  const formatted = formatMoney(Math.abs(minor), currency);
  return minor < 0 ? `−${formatted}` : `+${formatted}`;
}

/**
 * Parses what a user types ("1,250.5") into minor units (125050) using string
 * arithmetic, so values like 0.1 + 0.2 never go through floating point.
 * Returns null for anything that is not a positive amount with ≤ 2 decimals.
 */
export function parseToMinor(input: string): number | null {
  const cleaned = input.replace(/[,\s₹$]/g, '');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const minor = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return minor > 0 && Number.isSafeInteger(minor) ? minor : null;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
