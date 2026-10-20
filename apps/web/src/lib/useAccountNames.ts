import { useAccounts } from '../api/hooks';

/** Returns a lookup from account id to a display name (falls back to a short id). */
export function useAccountNames(): (id: string) => string {
  const { data } = useAccounts();
  const names = new Map((data?.items ?? []).map((account) => [account.id, account.name]));
  return (id) => names.get(id) ?? id.slice(0, 8);
}
