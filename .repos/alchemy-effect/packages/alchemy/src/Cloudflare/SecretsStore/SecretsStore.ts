import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

export type SecretsStore = Resource<
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
 *
 * @section Creating a Store
 * @example Basic Secrets Store (adopts existing or creates one)
 * ```typescript
 * const store = yield* Cloudflare.SecretsStore("MyStore");
 * ```
 *
 * @example Adopt a specific named store
 * ```typescript
 * const store = yield* Cloudflare.SecretsStore("MyStore", {
 *   name: "production-secrets",
 * });
 * ```
 */
export const SecretsStore = Resource<SecretsStore>("Cloudflare.SecretsStore");

export const SecretsStoreProvider = () =>
  Provider.effect(
    SecretsStore,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const createStore = yield* secretsStore.createStore;
      const listStores = yield* secretsStore.listStores;

      return {
        stables: ["storeId", "storeName", "accountId"],
        // The engine calls `read` whenever there's no prior state. Cloudflare
        // allows exactly one Secrets Store per account, so any account that's
        // ever provisioned one must reuse it. Returning the existing store as
        // plain attrs makes the engine silently adopt it; `create` is only
        // ever invoked when no store exists yet.
        read: Effect.fn(function* ({ output }) {
          const stores = yield* listStores({
            accountId: output?.accountId ?? accountId,
          });
          const match = output?.storeId
            ? stores.result.find((s) => s.id === output.storeId)
            : stores.result[0];
          if (!match) return undefined;
          return {
            storeId: match.id,
            storeName: match.name,
            accountId: output?.accountId ?? accountId,
          };
        }),
        reconcile: Effect.fn(function* ({ output }) {
          const acct = output?.accountId ?? accountId;

          // Observe — Cloudflare permits exactly one Secrets Store per
          // account. List the account's stores; reuse the cached one if
          // it still exists, otherwise reuse the first one.
          const stores = yield* listStores({ accountId: acct });
          const observed = output?.storeId
            ? (stores.result.find((s) => s.id === output.storeId) ??
              stores.result[0])
            : stores.result[0];

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
          const response = yield* createStore({
            accountId: acct,
            // `default_secrets_store` is the name Cloudflare uses for an
            // account's default Secrets Store.
            name: "default_secrets_store",
          }).pipe(
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

          const after = yield* listStores({ accountId: acct });
          const first = after.result[0];
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
        delete: Effect.fn(function* () {
          // Intentional no-op. Cloudflare only allows one Secrets Store per
          // account and deleting it permanently destroys all secrets inside.
          // The store is treated as shared, account-level infrastructure that
          // should never be torn down by a single stack.
        }),
      };
    }),
  );
