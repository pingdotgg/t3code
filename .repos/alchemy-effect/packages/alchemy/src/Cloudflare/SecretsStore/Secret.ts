import type { RuntimeServices } from "@alchemy.run/cloudflare-runtime/core";
import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as ProviderLayer from "../../Local/ProviderLayer.ts";
import * as RpcProvider from "../../Local/RpcProvider.ts";
import * as Provider from "../../Provider.ts";
import { isResourceOfType, Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import {
  generateLocalId,
  LOCAL_ENTRY_URL,
  localRuntimeServices,
} from "../LocalRuntime.ts";
import type { Providers } from "../Providers.ts";
import {
  deleteLocalSecret,
  seedLocalSecret,
} from "./LocalSecretsStoreGateway.ts";

export type StoreSecretProps = {
  /**
   * The Secrets Store that owns this secret.
   */
  store: {
    storeId: string;
    accountId: string;
  };
  /**
   * The name of the secret within the store.
   * If omitted, the resource's logical ID is used.
   */
  name?: string;
  /**
   * The secret value. Treated as redacted and never logged.
   */
  value: Redacted.Redacted<string>;
  /**
   * Services allowed to reference this secret.
   * @default ["workers"]
   */
  scopes?: string[];
  /**
   * Optional free-form description.
   */
  comment?: string;
};

export type Secret = Resource<
  "Cloudflare.SecretsStore.Secret",
  StoreSecretProps,
  {
    secretId: string;
    secretName: string;
    storeId: string;
    accountId: string;
    status: SecretStatus;
    scopes: string[];
    comment: string | undefined;
  },
  never,
  Providers
>;

export const isSecret = (value: unknown): value is Secret =>
  isResourceOfType(value, "Cloudflare.SecretsStore.Secret");

export type SecretStatus = "pending" | "active" | "deleted";

// Distilled widened generated string enums to open unions (`string & {}`); the
// API only ever returns the known variants, so narrow at the boundary.
const asSecretStatus = (status: string): SecretStatus => status as SecretStatus;

/**
 * A single secret stored inside a Cloudflare Secrets Store.
 *
 * The secret value is treated as redacted and is only ever sent to
 * Cloudflare at create time. Updating `scopes` or `comment` issues a
 * PATCH; changing `value` or `name` replaces the secret.
 * ### Creating a Secret
 * **Example:** Basic Secret
 * ```typescript
 * const store = yield* Cloudflare.SecretsStore.Store("MyStore");
 * const apiKey = yield* Cloudflare.SecretsStore.Secret("ApiKey", {
 *   store,
 *   value: Redacted.make(process.env.API_KEY!),
 * });
 * ```
 *
 * ### Binding to a Worker
 * **Example:** Reading a secret at runtime
 * ```typescript
 * const apiKey = yield* Cloudflare.SecretsStore.ReadSecret(ApiKey);
 * // `apiKey` is itself an Effect that resolves to the secret value:
 * const value = yield* apiKey;
 * // Or call `.get()` explicitly:
 * const value = yield* apiKey.get();
 * ```
 *
 * @resource
 * @product Secrets Store
 * @category Storage & Databases
 */
export const Secret = Resource<Secret>("Cloudflare.SecretsStore.Secret");

export const SecretProviderLive = () =>
  Provider.succeed(Secret, {
    stables: ["secretId", "secretName", "storeId", "accountId"],
    diff: Effect.fn(function* ({ id, olds = {} as any, news, output }) {
      if (!isResolved(news)) return undefined;
      const oldStoreId = output?.storeId ?? olds.store?.storeId;
      const newStoreId = news.store.storeId;
      const oldName = output?.secretName ?? resolveName(id, olds.name);
      const newName = resolveName(id, news.name);
      if (oldStoreId !== newStoreId || oldName !== newName) {
        return { action: "replace" } as const;
      }
      const oldValue = olds.value ? Redacted.value(olds.value) : undefined;
      const newValue = Redacted.value(news.value);
      if (oldValue !== newValue) {
        return { action: "update" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = resolveName(id, news.name);
      const scopes = resolveScopes(news.scopes);
      const accountId = news.store.accountId;
      const storeId = news.store.storeId;

      // Observe — re-fetch the cached secret; fall back to a name
      // scan over the store so we recover from out-of-band deletes
      // or partial state-persistence failures.
      let observed:
        | {
            id: string;
            name: string;
            storeId: string;
            status: string;
            comment?: string | null;
          }
        | undefined;
      if (output?.secretId) {
        observed = yield* secretsStore
          .getStoreSecret({
            accountId: output.accountId,
            storeId: output.storeId,
            secretId: output.secretId,
          })
          .pipe(
            Effect.catchTag("SecretNotFound", () => Effect.succeed(undefined)),
            Effect.catchTag("StoreNotFound", () => Effect.succeed(undefined)),
          );
      }
      if (!observed) {
        observed = yield* secretsStore.listStoreSecrets
          .items({ accountId, storeId })
          .pipe(
            Stream.filter((s) => s.name === name),
            Stream.runHead,
            Effect.catchTag("StoreNotFound", () => Effect.succeedNone),
            Effect.map(Option.getOrUndefined),
          );
      }

      // Ensure — create if missing. Cloudflare reports a concurrent
      // create as `SecretNameAlreadyExists`; tolerate by re-listing
      // the store and adopting the secret with the same name. The
      // value can't be read back from the API; we trust an
      // identically-named secret reflects the same intent.
      if (!observed) {
        const created = yield* secretsStore
          .createStoreSecret({
            accountId,
            storeId,
            body: [
              {
                name,
                scopes,
                value: Redacted.value(news.value),
                comment: news.comment,
              },
            ],
          })
          .pipe(
            Effect.catchTag("SecretNameAlreadyExists", () =>
              Effect.succeed(undefined),
            ),
          );
        if (created) {
          const secret = created.result[0]!;
          // Freshly created secrets report "pending" until Cloudflare
          // activates them; a worker deploy that references a pending
          // secret is rejected with "Secrets Store binding ... which
          // were not found". Wait (bounded) for activation so
          // downstream deploys in the same run see an active secret.
          const status = yield* waitForSecretActive(
            { accountId, storeId, secretId: secret.id },
            asSecretStatus(secret.status),
          );
          return {
            secretId: secret.id,
            secretName: secret.name,
            storeId: secret.storeId,
            accountId,
            status,
            scopes,
            comment: secret.comment ?? undefined,
          };
        }
        const existing = yield* secretsStore.listStoreSecrets
          .items({ accountId, storeId })
          .pipe(
            Stream.filter((s) => s.name === name),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          );
        if (!existing) {
          return yield* Effect.die(
            new Error(
              `Secret '${name}' reported as already existing in store ${storeId} but could not be found on lookup.`,
            ),
          );
        }
        observed = existing;
      }

      const patched = yield* secretsStore.patchStoreSecret({
        accountId,
        storeId,
        secretId: observed.id,
        scopes,
        comment: news.comment,
        value: Redacted.value(news.value),
      });
      const status = yield* waitForSecretActive(
        { accountId, storeId, secretId: observed.id },
        asSecretStatus(patched.status),
      );
      return {
        secretId: observed.id,
        secretName: observed.name,
        storeId: observed.storeId,
        accountId,
        status,
        scopes,
        comment: patched.comment ?? undefined,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* secretsStore
        .deleteStoreSecret({
          accountId: output.accountId,
          storeId: output.storeId,
          secretId: output.secretId,
        })
        .pipe(
          Effect.tap(() => Effect.log(`deleted ${output.secretId}`)),
          Effect.tapError(Console.log),
          Effect.catchTag("SecretNotFound", () => Effect.void),
          Effect.catchTag("StoreNotFound", () => Effect.void),
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output?.secretId) {
        return yield* secretsStore
          .getStoreSecret({
            accountId: output.accountId,
            storeId: output.storeId,
            secretId: output.secretId,
          })
          .pipe(
            Effect.map((secret) => ({
              secretId: secret.id,
              secretName: secret.name,
              storeId: secret.storeId,
              accountId: output.accountId,
              status: asSecretStatus(secret.status),
              scopes: output.scopes,
              comment: secret.comment ?? undefined,
            })),
            Effect.catchTag("SecretNotFound", () => Effect.succeed(undefined)),
            Effect.catchTag("StoreNotFound", () => Effect.succeed(undefined)),
          );
      }
      // An interrupted first deploy can persist `creating` props whose
      // parent Outputs were stripped to holes (see stripUnresolved), so
      // `olds.store` can survive as `{}`. Treat an unresolved parent
      // reference like a missing one — the plan falls through to the
      // create path instead of handing `undefined` to the API (#995).
      if (!olds?.store?.storeId || !olds.store.accountId) return undefined;
      const name = resolveName(id, olds.name);
      const match = yield* secretsStore.listStoreSecrets
        .items({
          accountId: olds.store.accountId,
          storeId: olds.store.storeId,
        })
        .pipe(
          Stream.filter((s) => s.name === name),
          Stream.runHead,
          Effect.catchTag("StoreNotFound", () => Effect.succeedNone),
          Effect.map(Option.getOrUndefined),
        );
      if (!match) return undefined;
      // Secrets carry no ownership signal (Cloudflare doesn't expose
      // tags on store secrets), so a name match is not proof we own
      // it. Brand it `Unowned` so the engine surfaces
      // `OwnedBySomeoneElse` unless the caller opted in via `--adopt`.
      return Unowned({
        secretId: match.id,
        secretName: match.name,
        storeId: match.storeId,
        accountId: olds.store.accountId,
        status: asSecretStatus(match.status),
        scopes: resolveScopes(olds.scopes),
        comment: match.comment ?? undefined,
      });
    }),
    // Parent fan-out: secrets are sub-resources keyed by {accountId,
    // storeId} and there is no account-wide secret enumeration API.
    // Enumerate every Secrets Store in the account, then list the
    // secrets inside each store with bounded concurrency, paginating
    // both levels exhaustively. The secret value is write-only and is
    // never returned by the API — matching `read`, it is omitted.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const stores = yield* secretsStore.listStores.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) => page.result ?? []),
        ),
      );
      const rows = yield* Effect.forEach(
        stores,
        (store) =>
          secretsStore.listStoreSecrets
            .pages({ accountId, storeId: store.id })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.result ?? []).map((secret) => ({
                    secretId: secret.id,
                    secretName: secret.name,
                    storeId: secret.storeId,
                    accountId,
                    status: asSecretStatus(secret.status),
                    scopes: resolveScopes(secret.scopes ?? undefined),
                    comment: secret.comment ?? undefined,
                  })),
                ),
              ),
              // A store deleted out-of-band between enumeration and
              // listing its secrets surfaces as StoreNotFound — skip it.
              Effect.catchTag("StoreNotFound", () =>
                Effect.succeed([] as ReadonlyArray<Secret["Attributes"]>),
              ),
            ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),
  });

/**
 * Local (dev) provider — the secret's identity is virtual (a `dev:` id) but
 * its VALUE is real: reconcile seeds it into the local workerd Secrets
 * Store simulator (through the `SecretsStore.admin` gateway, see
 * `LocalSecretsStoreGateway.ts`) so a dev worker's `env.SECRET.get()`
 * returns it, and delete removes the key again. Data lands in the same
 * `.alchemy/local/secrets-store` directory the worker's lowered
 * `secrets_store_secret` binding reads.
 *
 * RPC-backed: under `alchemy dev` (an `RpcProviderProxy` in context) the
 * whole lifecycle runs in the Cloudflare sidecar process — where
 * `localRuntimeServices()` is real and shared with the Worker/Queue/D1
 * local providers — instead of in the user's process where that layer is
 * gated empty (the class of bug behind #1007). In-process runs (no proxy:
 * `sidecar: false` tests, a plain deploy deleting a local-mode row) build
 * the provider directly with the un-gated runtime from the `dual`
 * registration.
 */
export const SecretProviderLocal = () =>
  RpcProvider.effect(
    Secret,
    LOCAL_ENTRY_URL,
    Effect.gen(function* () {
      // The local runtime services (workerd `Runtime`, binding plugins) and
      // the HTTP client are resolved once at layer build and closed over —
      // lifecycle effects run with the engine's call-time context, which
      // doesn't include them.
      const runtimeContext = yield* Effect.context<
        RuntimeServices | HttpClient.HttpClient
      >();

      return {
        stables: ["accountId"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!output?.secretId) return { action: "update" } as const;
          if (!isResolved(news)) return undefined;
          // Mirror the live provider's rules: a new store or name replaces
          // the secret; a new value updates it in place (re-seed).
          const oldStoreId = output.storeId;
          const oldName = output.secretName;
          const newName = resolveName(id, news.name);
          if (oldStoreId !== news.store.storeId || oldName !== newName) {
            return { action: "replace" } as const;
          }
          const oldValue = olds?.value ? Redacted.value(olds.value) : undefined;
          if (oldValue !== Redacted.value(news.value)) {
            return { action: "update" } as const;
          }
          // Fall through to the engine's default prop diff (scopes/comment
          // changes update in place).
        }),
        read: Effect.fn(function* ({ output }) {
          // Virtual identity — the persisted state row is the source of
          // truth (the seeded value converges on every reconcile).
          return output ?? undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = resolveName(id, news.name);
          const storeId = news.store.storeId;

          // Seed — write the value into the local simulator so the dev
          // worker's `env.<binding>.get()` returns it. An overwrite is
          // idempotent, so re-running after a crash converges.
          yield* seedLocalSecret(
            storeId,
            name,
            Redacted.value(news.value),
          ).pipe(Effect.provideContext(runtimeContext));

          return {
            secretId: output?.secretId ?? generateLocalId(),
            secretName: name,
            storeId,
            accountId: news.store.accountId,
            status: "active" as const,
            scopes: resolveScopes(news.scopes),
            comment: news.comment,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // Remove the seeded value (idempotent — deleting a missing key is
          // a no-op). A create-first replacement's old generation deletes a
          // different key than its successor seeded, so this never races.
          yield* deleteLocalSecret(output.storeId, output.secretName).pipe(
            Effect.provideContext(runtimeContext),
          );
        }),
      };
    }),
  );

export const StoreSecretProvider = () =>
  ProviderLayer.dual(Secret, {
    // The local provider's reconcile/delete boot an ephemeral workerd
    // gateway to seed the simulator, so it needs the shared local runtime
    // layer. Under `alchemy dev` the provider is an RPC stub (this gated
    // layer is empty and unused) and the sidecar entry (`../Local.ts`)
    // supplies the real runtime; without the proxy the provider builds
    // in-process and this layer is real.
    local: () =>
      SecretProviderLocal().pipe(Layer.provide(localRuntimeServices())),
    live: () => SecretProviderLive(),
  });

/**
 * Poll a secret until Cloudflare reports it "active" (bounded at
 * ~10s). Returns the last observed status rather than failing on
 * timeout — consumers that bind the secret retry the
 * `SecretsStoreBindingNotFound` deploy rejection themselves, so a
 * slow activation degrades to a retried deploy instead of a hard
 * error here.
 */
const waitForSecretActive = (
  key: { accountId: string; storeId: string; secretId: string },
  initialStatus: SecretStatus,
) =>
  initialStatus === "active"
    ? Effect.succeed<SecretStatus>("active")
    : secretsStore.getStoreSecret(key).pipe(
        Effect.map((s) => asSecretStatus(s.status)),
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (status) => status === "active",
          times: 20,
        }),
        // The secret was observed moments ago; a NotFound here is a
        // read-replica lag blip, not a deletion. Report the last known
        // status and let the deploy-side retry take over.
        Effect.catchTag("SecretNotFound", () => Effect.succeed(initialStatus)),
        Effect.catchTag("StoreNotFound", () => Effect.succeed(initialStatus)),
      );

const resolveScopes = (scopes: string[] | undefined): string[] =>
  scopes && scopes.length > 0 ? scopes : ["workers"];

const resolveName = (id: string, name: string | undefined): string =>
  name ?? id;
