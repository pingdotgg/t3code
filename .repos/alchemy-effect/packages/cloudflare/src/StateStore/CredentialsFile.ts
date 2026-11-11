import type { CredentialsStoreService } from "alchemy/Auth/Credentials";
import { withLock } from "alchemy/Auth/Lock";
import { profileStateStoresDirPath } from "alchemy/Auth/Paths";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Cache of the Cloudflare-deployed HTTP state stores' endpoints + bearer
 * tokens, at `~/.alchemy/profiles/{profile}/state-stores/cloudflare.json`.
 *
 * Kept in this leaf module (rather than `StateStore/State.ts`) so the
 * Cloudflare auth provider can invalidate the cache on
 * `profile edit` / provider logout without importing the heavy state-store
 * module and creating an import cycle
 * (`StateStore/State.ts` -> `Providers.ts` -> `Auth/AuthProvider.ts`).
 */
export const CREDENTIALS_FILE = "cloudflare";

/**
 * The single-store cache earlier releases keep at
 * `~/.alchemy/credentials/{profile}/cloudflare-state-store.json`. Copied into
 * {@link CREDENTIALS_FILE} once and never written, so those releases keep
 * working.
 */
export const LEGACY_CREDENTIALS_FILE = "cloudflare-state-store";

const stateStores = (store: CredentialsStoreService) => store.scoped(profileStateStoresDirPath);

/**
 * On-disk shape of the cached Cloudflare state-store credentials.
 *
 * Extends the generic `HttpStateStoreCredentials` (`{ url, authToken }`)
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
export const StoredStateStoreCredentials = Schema.Struct({
  url: Schema.String,
  /** Bearer token used to authenticate every request. */
  authToken: Schema.String,
  /** Cloudflare account ID the `url`/`authToken` were minted against. */
  accountId: Schema.optional(Schema.String),
});
export type StoredStateStoreCredentials = typeof StoredStateStoreCredentials.Type;

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
): boolean => credentials.accountId == null || credentials.accountId !== currentAccountId;

/** The default state store's name; a legacy file holds its credentials alone. */
const DEFAULT_STORE = "alchemy-state-store";

/**
 * Every state store's cached credentials for a profile, by store name, in
 * the one {@link CREDENTIALS_FILE}: {@link clearStoreCredentials} (on
 * `profile edit`, logout, or an account change) clears them all.
 */
const StoredStateStores = Schema.Struct({
  stores: Schema.Record(Schema.String, StoredStateStoreCredentials),
});

/** It is only a cache, so a file that can't be read counts as empty. */
const readStores = (store: CredentialsStoreService, profile: string) =>
  stateStores(store)
    .read(profile, CREDENTIALS_FILE, StoredStateStores)
    .pipe(
      Effect.map((file): Record<string, StoredStateStoreCredentials> => file?.stores ?? {}),
      Effect.orElseSucceed((): Record<string, StoredStateStoreCredentials> => ({})),
    );

const writeStores = (
  store: CredentialsStoreService,
  profile: string,
  stores: Record<string, StoredStateStoreCredentials>,
) => stateStores(store).write(profile, CREDENTIALS_FILE, StoredStateStores, { stores });

/**
 * Copy the legacy file, which holds the default store's credentials alone,
 * into {@link CREDENTIALS_FILE} the first time a profile's cache is used.
 * The legacy file is left in place. It is only a cache, so one that can't be
 * read is skipped.
 */
const migrateLegacy = (store: CredentialsStoreService, profile: string) =>
  Effect.gen(function* () {
    const current = yield* stateStores(store)
      .read(profile, CREDENTIALS_FILE, StoredStateStores)
      .pipe(Effect.orElseSucceed(() => null));
    if (current !== undefined) return;
    const legacy = yield* store
      .read(profile, LEGACY_CREDENTIALS_FILE, StoredStateStoreCredentials)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (legacy !== undefined) yield* writeStores(store, profile, { [DEFAULT_STORE]: legacy });
  });

/** One state store's cached credentials, if any. */
export const readStoreCredentials = (
  store: CredentialsStoreService,
  profile: string,
  storeName: string,
) =>
  withFileLock(
    profile,
    migrateLegacy(store, profile).pipe(
      Effect.andThen(readStores(store, profile)),
      Effect.map((stores) => stores[storeName]),
    ),
  );

/**
 * Serialize read-modify-writes of a profile's file across fibers and
 * processes, so two stores bootstrapping at once keep both entries. Its own
 * lock, not the profile-credentials one, which callers may already hold.
 */
const withFileLock = <A, E, R>(profile: string, effect: Effect.Effect<A, E, R>) =>
  withLock(`cloudflare-state-store-${profile}`, effect, {
    label: "Cloudflare state-store credentials",
  });

/** Cache one state store's credentials beside the profile's other stores. */
export const writeStoreCredentials = (
  store: CredentialsStoreService,
  profile: string,
  storeName: string,
  credentials: StoredStateStoreCredentials,
) =>
  withFileLock(
    profile,
    migrateLegacy(store, profile).pipe(
      Effect.andThen(readStores(store, profile)),
      Effect.flatMap((stores) =>
        writeStores(store, profile, { ...stores, [storeName]: credentials }),
      ),
    ),
  );

/** Drop one state store's cached credentials. */
export const deleteStoreCredentials = (
  store: CredentialsStoreService,
  profile: string,
  storeName: string,
) =>
  withFileLock(
    profile,
    migrateLegacy(store, profile).pipe(
      Effect.andThen(readStores(store, profile)),
      Effect.flatMap(({ [storeName]: _, ...rest }) => writeStores(store, profile, rest)),
    ),
  );

/**
 * Drop every state store's cached credentials for a profile. Leaves an empty
 * file rather than none, so the legacy cache is not migrated again. One
 * atomic write, so it needs no lock.
 */
export const clearStoreCredentials = (store: CredentialsStoreService, profile: string) =>
  writeStores(store, profile, {});
