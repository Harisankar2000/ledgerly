const API_KEY_STORAGE = 'ledgerly.apiKey';
const DEFAULT_API_KEY = import.meta.env.VITE_API_KEY ?? 'dev-ledger-key';

export function getApiKey(): string {
  try {
    return localStorage.getItem(API_KEY_STORAGE) ?? DEFAULT_API_KEY;
  } catch {
    return DEFAULT_API_KEY;
  }
}

export function setApiKey(value: string): void {
  try {
    localStorage.setItem(API_KEY_STORAGE, value);
  } catch {
    // Storage can be unavailable (private mode); the default key still works.
  }
}

/** The API's error shape: `{ error: { code, message, details } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Sent as Idempotency-Key; reuse the same value when retrying the same action. */
  idempotencyKey?: string;
  query?: Record<string, string | number | undefined>;
}

export async function request<T>(
  path: string,
  { method = 'GET', body, idempotencyKey, query }: RequestOptions = {},
): Promise<T> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const url = `/api/v1${path}${params.size ? `?${params}` : ''}`;

  const response = await fetch(url, {
    method,
    headers: {
      'x-api-key': getApiKey(),
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...(idempotencyKey && { 'idempotency-key': idempotencyKey }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(
      response.status,
      error.code ?? 'UNKNOWN',
      error.message ?? response.statusText,
      error.details,
    );
  }
  return payload as T;
}
