import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { isResourceOfType, Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

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
 * @resource
 * @product Secrets Store
 * @category Storage & Databases
 * @section Creating a Secret
 * @example Basic Secret
 * ```typescript
 * const store = yield* Cloudflare.SecretsStore.Store("MyStore");
 * const apiKey = yield* Cloudflare.SecretsStore.Secret("ApiKey", {
 *   store,
 *   value: Redacted.make(process.env.API_KEY!),
 * });
 * ```
 *
 * @section Binding to a Worker
 * @example Reading a secret at runtime
 * ```typescript
 * const apiKey = yield* Cloudflare.SecretsStore.ReadSecret(ApiKey);
 * // `apiKey` is itself an Effect that resolves to the secret value:
 * const value = yield* apiKey;
 * // Or call `.get()` explicitly:
 * const value = yield* apiKey.get();
 * ```
 */
export const Secret = Resource<Secret>("Cloudflare.SecretsStore.Secret");

export const StoreSecretProvider = () =>
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
      if (!olds?.store) return undefined;
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
