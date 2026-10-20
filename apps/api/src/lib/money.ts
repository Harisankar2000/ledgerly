import { z } from 'zod';

export const SUPPORTED_CURRENCIES = ['INR', 'USD'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export const currencySchema = z.enum(SUPPORTED_CURRENCIES);

/** Upper bound per operation: 10 crore rupees / 10 million dollars, in minor units. */
export const MAX_AMOUNT_MINOR = 10_000_000_000;

/** Amounts are integers in minor units (paise, cents). Floats never touch money. */
export const amountSchema = z
  .number()
  .int('Amount must be an integer in minor units (e.g. paise)')
  .positive()
  .max(MAX_AMOUNT_MINOR);

const MINOR_UNITS: Record<Currency, number> = { INR: 2, USD: 2 };

/** Formats minor units for humans: formatMinor(123456, 'INR') -> "₹1,234.56". */
export function formatMinor(amount: number, currency: Currency): string {
  const digits = MINOR_UNITS[currency];
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
  }).format(amount / 10 ** digits);
}
