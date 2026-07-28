import type { HttpStateStoreCredentials } from "../../State/HttpStateStore.ts";

/**
 * Filename (under `~/.alchemy/credentials/{profile}/`) used to cache the
 * Cloudflare-deployed HTTP state store's endpoint + bearer token.
 *
 * Kept in this leaf module (rather than `StateStore/State.ts`) so the
 * Cloudflare auth provider can invalidate the cache on
 * `login --configure` / `logout` without importing the heavy state-store
 * module and creating an import cycle
 * (`StateStore/State.ts` -> `Providers.ts` -> `Auth/AuthProvider.ts`).
 */
export const CREDENTIALS_FILE = "cloudflare-state-store";

/**
 * On-disk shape of the cached Cloudflare state-store credentials.
 *
 * Extends the generic {@link HttpStateStoreCredentials} (`{ url, authToken }`)
 * with the `accountId` the credentials were minted against. The `url` already
 * encodes the account (via the `*.workers.dev` subdomain), so a cache written
 * while logged into account A keeps pointing at account A's state store even
 * after the user re-authenticates against account B. Persisting `accountId`
 * lets `state()` detect that mismatch and re-derive.
 *
 * `accountId` is optional so legacy files written before this field existed
 * still parse — they are treated as stale (see
 * {@link isStateStoreCredentialsStale}) and re-derived on next use.
 */
export interface StoredStateStoreCredentials extends HttpStateStoreCredentials {
  /** Cloudflare account ID the `url`/`authToken` were minted against. */
  accountId?: string;
}

/**
 * `true` when cached state-store credentials must not be trusted for the
 * current account:
 *
 * - the file predates the `accountId` field (legacy cache — exactly the
 *   artifact that caused deploys to silently target the wrong account), or
 * - it was minted against a different account than the one now in use.
 *
 * A stale cache is discarded and re-derived from the current account.
 */
export const isStateStoreCredentialsStale = (
  credentials: StoredStateStoreCredentials,
  currentAccountId: string,
): boolean =>
  credentials.accountId == null || credentials.accountId !== currentAccountId;
