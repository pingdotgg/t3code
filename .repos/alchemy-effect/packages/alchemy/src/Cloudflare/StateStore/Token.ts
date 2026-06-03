import { Random } from "../../Random.ts";
import * as Effect from "effect/Effect";
import * as Secret from "../SecretsStore/Secret.ts";
import { SecretsStore } from "../SecretsStore/SecretsStore.ts";

/**
 * The account-wide Secrets Store that backs every secret used by the
 * state store worker. `SecretsStore` adopts the single store that
 * already exists on the account, or creates one if none exists.
 */
export const Store = SecretsStore("StateStoreSecrets");

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
 * The bearer token used to authenticate every request to the state
 * store worker. The value comes from {@link TokenValue} and lives in
 * the account-wide Cloudflare Secrets Store so it can be bound into
 * the worker without bundling the raw string.
 */
export const AuthToken = Effect.gen(function* () {
  const store = yield* Store;
  const random = yield* TokenValue;
  return yield* Secret.Secret(AuthTokenSecretName, {
    name: AuthTokenSecretName,
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

export const EncryptionKeySecretName =
  "AlchemyStateStoreEncryptionKey" as const;

/**
 * The encryption key secret. The raw hex-encoded bytes live inside
 * Cloudflare's Secrets Store; the Durable Object binds to it at
 * runtime to derive an AES-CTR `CryptoKey` via Web Crypto's
 * `subtle.importKey`.
 */
export const EncryptionKey = Effect.gen(function* () {
  const store = yield* Store;
  const random = yield* EncryptionKeyValue;
  return yield* Secret.Secret("StateStoreEncryptionKey", {
    name: EncryptionKeySecretName,
    store,
    value: random.text,
  });
});
