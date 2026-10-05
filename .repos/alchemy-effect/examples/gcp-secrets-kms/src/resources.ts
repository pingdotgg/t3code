import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";

/**
 * The container for the key. Cloud KMS has no key ring delete API, so
 * `alchemy destroy` only forgets the ring; an empty ring costs nothing.
 */
export const Keys = GCP.KMS.KeyRing("Keys", {});

/**
 * The symmetric key the service encrypts with. Key material never leaves
 * KMS — the service only ever sees ciphertext and plaintext.
 *
 * KMS keeps destroyed keys for at least a day, so `alchemy destroy`
 * *releases* this key (schedules every version for destruction and labels
 * it `alchemy-released`). A deploy that asks for the same key id reclaims
 * it and mints a fresh primary version.
 */
export const DataKey = Effect.gen(function* () {
  const keys = yield* Keys;
  return yield* GCP.KMS.CryptoKey("DataKey", {
    keyRing: keys.name,
    purpose: "ENCRYPT_DECRYPT",
  });
});

/**
 * The key callers must present in `x-api-key`. Only the service reads it,
 * and only at request time.
 *
 * Alchemy creates the secret; adding the *version* that holds the value
 * is an operator step:
 *
 * ```sh
 * printf 'my-key' | gcloud secrets versions add "$SECRET_ID" --data-file=-
 * ```
 */
export const ApiKey = GCP.SecretManager.Secret("ApiKey", {});
