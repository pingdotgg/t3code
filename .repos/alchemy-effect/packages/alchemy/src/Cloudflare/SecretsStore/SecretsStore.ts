import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

export type Store = Resource<
  "Cloudflare.SecretsStore",
  {},
  {
    storeId: string;
    storeName: string;
    accountId: string;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Secrets Store, a per-account container for secrets that
 * can be bound into Workers with full redaction and audit support.
 *
 * Cloudflare enforces a limit of **one Secrets Store per account**.
 * Deleting a store changes its ID and permanently destroys all secrets
 * inside it. Because of this, the provider always **adopts** an existing
 * store rather than creating a new one, and **never deletes** the store
 * on teardown. The `read` lifecycle reports the existing account store
 * (if any) as plain attrs, so the engine silently adopts it on cold
 * start and `create` is only ever invoked when no store exists yet.
 * Once it exists it is treated as account-level infrastructure that
 * outlives any single stack.
 * @resource
 * @product Secrets Store
 * @category Storage & Databases
 * @section Creating a Store
 * @example Basic Secrets Store (adopts existing or creates one)
 * ```typescript
 * const store = yield* Cloudflare.SecretsStore.Store("MyStore");
 * ```
 *
 * @example Adopt a specific named store
 * ```typescript
 * const store = yield* Cloudflare.SecretsStore.Store("MyStore", {
 *   name: "production-secrets",
 * });
 * ```
 */
export const Store = Resource<Store>("Cloudflare.SecretsStore");

export const SecretsStoreProvider = () =>
  Provider.succeed(Store, {
    stables: ["storeId", "storeName", "accountId"],
    // The engine calls `read` whenever there's no prior state. Cloudflare
    // allows exactly one Secrets Store per account, so any account that's
    // ever provisioned one must reuse it. Returning the existing store as
    // plain attrs makes the engine silently adopt it; `create` is only
    // ever invoked when no store exists yet.
    read: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const match = output?.storeId
        ? yield* findStoreById(acct, output.storeId)
        : yield* firstStore(acct);
      if (!match) return undefined;
      return {
        storeId: match.id,
        storeName: match.name,
        accountId: acct,
      };
    }),
    reconcile: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Observe — Cloudflare permits exactly one Secrets Store per
      // account. Reuse the cached store if it still exists, otherwise
      // reuse the first one listed.
      const cached = output?.storeId
        ? yield* findStoreById(acct, output.storeId)
        : undefined;
      const observed = cached ?? (yield* firstStore(acct));

      if (observed) {
        return {
          storeId: observed.id,
          storeName: observed.name,
          accountId: acct,
        };
      }

      // Ensure — no store yet. Create the default. Cloudflare reports
      // a concurrent create as `MaximumStoresExceeded`; tolerate by
      // re-listing and adopting the now-existing store.
      const response = yield* secretsStore
        .createStore({
          accountId: acct,
          // `default_secrets_store` is the name Cloudflare uses for an
          // account's default Secrets Store.
          name: "default_secrets_store",
        })
        .pipe(
          Effect.catchTag("MaximumStoresExceeded", () =>
            Effect.succeed(undefined),
          ),
        );

      if (response) {
        return {
          storeId: response.id,
          storeName: response.name,
          accountId: acct,
        };
      }

      const first = yield* firstStore(acct);
      if (first) {
        return {
          storeId: first.id,
          storeName: first.name,
          accountId: acct,
        };
      }

      return yield* Effect.die(
        new Error(
          `Cloudflare reported MaximumStoresExceeded for account ${acct} but no store could be listed.`,
        ),
      );
    }),
    // Account-scoped collection. Cloudflare exposes a paginated
    // `secrets_store/stores` list op; enumerate every page and hydrate each
    // store into the exact `read` Attributes shape. Cloudflare currently
    // permits only one (default) store per account, so this is usually a
    // single-element array, but the enumeration is exhaustive regardless.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* secretsStore.listStores.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((store) => ({
              storeId: store.id,
              storeName: store.name,
              accountId: store.accountId ?? accountId,
            })),
          ),
        ),
      );
    }),
    delete: Effect.fn(function* () {
      // Intentional no-op. Cloudflare only allows one Secrets Store per
      // account and deleting it permanently destroys all secrets inside.
      // The store is treated as shared, account-level infrastructure that
      // should never be torn down by a single stack.
    }),
  });

/** First store on the account (Cloudflare permits at most one). */
const firstStore = (accountId: string) =>
  secretsStore.listStores
    .items({ accountId })
    .pipe(Stream.runHead, Effect.map(Option.getOrUndefined));

/** Look a store up by id, terminating pagination on the first match. */
const findStoreById = (accountId: string, storeId: string) =>
  secretsStore.listStores.items({ accountId }).pipe(
    Stream.filter((s) => s.id === storeId),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );
