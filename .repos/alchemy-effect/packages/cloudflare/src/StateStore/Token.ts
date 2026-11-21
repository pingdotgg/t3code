import { Random } from "alchemy/Random";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Secret from "../SecretsStore/Secret.ts";
import { Store as SecretsStore } from "../SecretsStore/SecretsStore.ts";

/**
 * The account-wide Secrets Store that backs every secret used by the
 * state store worker. `SecretsStore` adopts the single store that
 * already exists on the account, or creates one if none exists.
 */
export const Store = SecretsStore("StateStoreSecrets");

/** The default state store's Worker name. */
export const DEFAULT_STATE_STORE_NAME = "alchemy-state-store" as const;

/**
 * Which state store a deploy builds: its Worker's name. The default store
 * keeps the original Worker and secret names, so existing deploys don't move.
 * Inside the deployed Worker it reads as the default; the runtime never needs
 * its own name.
 */
export const StateStoreName = Context.Reference<string>("alchemy/Cloudflare/StateStoreName", {
  defaultValue: () => DEFAULT_STATE_STORE_NAME,
});

/**
 * A state store's secret name in the account-wide Secrets Store: the
 * default store's is `base`, a named store's is suffixed with its name.
 */
export const stateStoreSecretName = (base: string, storeName: string) =>
  storeName === DEFAULT_STATE_STORE_NAME
    ? base
    : `${base}_${storeName.replace(/[^A-Za-z0-9_]/g, "_")}`;

/**
 * The randomly generated bearer token value. Generated once on create
 * and persisted in alchemy state, so subsequent deploys keep the same
 * value unless the resource is replaced.
 */
export const TokenValue = Random("StateStoreAuthTokenValue");

/**
 * The name of the secret in the Cloudflare Secrets Store that contains the bearer token.
 */
export const AuthTokenSecretName = "AlchemyStateStoreToken" as const;

/**
 * The Worker env bindings the runtime reads the two secrets through: each
 * `Secret` resource's logical ID. `Deploy.ts` uploads bindings under these
 * names, so they must not change while stores are deployed.
 */
export const AuthTokenBinding = AuthTokenSecretName;
export const EncryptionKeyBinding = "StateStoreEncryptionKey" as const;

/**
 * The bearer token used to authenticate every request to the state
 * store worker. The value comes from {@link TokenValue} and lives in
 * the account-wide Cloudflare Secrets Store so it can be bound into
 * the worker without bundling the raw string.
 */
export const AuthToken = Effect.gen(function* () {
  const store = yield* Store;
  const random = yield* TokenValue;
  return yield* Secret.Secret(AuthTokenBinding, {
    name: stateStoreSecretName(AuthTokenSecretName, yield* StateStoreName),
    store,
    value: random.text,
  });
});

/**
 * A 32-byte (256-bit) random value, hex-encoded, that seeds the
 * AES-CTR key used to encrypt resource state at rest. Generated once
 * and persisted, so the ciphertext stored by the Durable Object can
 * always be decrypted by subsequent worker boots.
 */
export const EncryptionKeyValue = Random("StateStoreEncryptionKeyValue", {
  bytes: 32,
});

export const EncryptionKeySecretName = "AlchemyStateStoreEncryptionKey" as const;

/**
 * The encryption key secret. The raw hex-encoded bytes live inside
 * Cloudflare's Secrets Store; the Durable Object binds to it at
 * runtime to derive an AES-CTR `CryptoKey` via Web Crypto's
 * `subtle.importKey`.
 */
export const EncryptionKey = Effect.gen(function* () {
  const store = yield* Store;
  const random = yield* EncryptionKeyValue;
  return yield* Secret.Secret(EncryptionKeyBinding, {
    name: stateStoreSecretName(EncryptionKeySecretName, yield* StateStoreName),
    store,
    value: random.text,
  });
});
