/**
 * Node-side seeding path into the local workerd Secrets Store simulator,
 * built on the runtime's platform proxy (`PlatformProxy.open` — our
 * `getPlatformProxy`).
 *
 * For a `dev:` store there is no cloud API to speak REST to. The local
 * `Secret` provider instead writes values through the runtime's
 * `SecretsStore.admin` hook — the raw KV-namespace view of a store (the
 * equivalent of Miniflare's `getSecretsStoreSecretAPI` admin surface): a
 * scoped platform proxy hosts the binding and Node drives it natively.
 *
 *   Node ── proxy.env.STORE.put(name, value) ──▶ secrets-store service
 *
 * Data lands in the same `{storage}/secrets-store` directory every local
 * worker's `secrets_store_secret` binding reads.
 *
 * NOT exported from `index.ts` — provider-internal scaffolding.
 */
import type * as runtime from "@cloudflare/workers-types";
import { SecretsStore } from "@alchemy.run/cloudflare-runtime/core/bindings";
import { open } from "@alchemy.run/cloudflare-runtime/core/platform-proxy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { gatewayName } from "../LocalGateway.ts";

export class LocalSecretsStoreError extends Data.TaggedError(
  "LocalSecretsStoreError",
)<{
  message: string;
  cause?: unknown;
}> {}

/**
 * Boot a scoped platform proxy for `storeId`, hand `use` the store's raw
 * KV-namespace admin surface, and tear the instance down when `use`
 * completes. One proxy boot per operation — slow but correct; callers are
 * provider lifecycle operations, not a request path.
 */
export const withLocalSecretsStore = <A, E, R>(
  storeId: string,
  use: (store: runtime.KVNamespace<string>) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const proxy = yield* open({
        name: gatewayName("alchemy-secrets-store-gateway", storeId),
        bindings: [SecretsStore.admin({ binding: "STORE", storeId })],
      });
      const store = (proxy.env as Record<string, unknown>)
        .STORE as runtime.KVNamespace<string>;
      return yield* use(store);
    }),
  );

/** Write a secret value into the local store (idempotent overwrite). */
export const seedLocalSecret = (
  storeId: string,
  secretName: string,
  value: string,
) =>
  withLocalSecretsStore(storeId, (store) =>
    Effect.tryPromise({
      try: () => store.put(secretName, value),
      catch: (cause) =>
        new LocalSecretsStoreError({
          message: `Failed to seed secret "${secretName}" into the local Secrets Store`,
          cause,
        }),
    }),
  );

/** Remove a secret from the local store (idempotent). */
export const deleteLocalSecret = (storeId: string, secretName: string) =>
  withLocalSecretsStore(storeId, (store) =>
    Effect.tryPromise({
      try: () => store.delete(secretName),
      catch: (cause) =>
        new LocalSecretsStoreError({
          message: `Failed to delete secret "${secretName}" from the local Secrets Store`,
          cause,
        }),
    }),
  );
