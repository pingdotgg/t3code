import type * as kms from "@distilled.cloud/aws/kms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AliasName } from "./Alias.ts";
import type { Key } from "./Key.ts";

export interface DecryptRequest extends Omit<kms.DecryptRequest, "KeyId"> {}

/**
 * Runtime binding for `kms:Decrypt`.
 *
 * Bind this operation to a KMS {@link Key} (or the `alias/...` name of a
 * pre-existing key) inside a function runtime to get a callable that
 * automatically injects the `KeyId`. Passing the key explicitly (rather than
 * relying on the metadata KMS embeds in symmetric ciphertext) pins decryption
 * to the intended key, per AWS best practice.
 *
 * The decrypted `Plaintext` in the response is wrapped in `Redacted` so it
 * never leaks into logs — unwrap with `Redacted.value(...)` at the point of
 * use.
 *
 * @binding
 * @section Decrypting Data
 * @example Decrypt a Ciphertext
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * const decrypt = yield* AWS.KMS.Decrypt(key);
 *
 * const response = yield* decrypt({ CiphertextBlob: ciphertext });
 * const plaintext = Redacted.isRedacted(response.Plaintext)
 *   ? Redacted.value(response.Plaintext)
 *   : response.Plaintext; // Uint8Array
 * ```
 *
 * @example Decrypt with an Encryption Context
 * ```typescript
 * // Must match the context used at encryption time exactly, otherwise the
 * // call fails with a typed InvalidCiphertextException.
 * const response = yield* decrypt({
 *   CiphertextBlob: ciphertext,
 *   EncryptionContext: { tenant: "acme" },
 * });
 * ```
 *
 * @section Pre-Existing Keys
 * @example Bind by Alias Name
 * ```typescript
 * const decrypt = yield* AWS.KMS.Decrypt("alias/app-key");
 * ```
 *
 * @section Wiring
 * @example Provide the Implementation on a Lambda Function
 * ```typescript
 * // Provide the DecryptHttp layer on the Function's init Effect,
 * // merged with the other KMS layers the function binds.
 * export default CryptoFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     const key = yield* AWS.KMS.Key("AppKey");
 *     const encrypt = yield* AWS.KMS.Encrypt(key);
 *     const decrypt = yield* AWS.KMS.Decrypt(key);
 *     // ... use encrypt/decrypt in the fetch handler
 *     return { fetch: handler };
 *   }).pipe(
 *     Effect.provide(Layer.mergeAll(AWS.KMS.EncryptHttp, AWS.KMS.DecryptHttp)),
 *   ),
 * );
 * ```
 */
export interface Decrypt extends Binding.Service<
  Decrypt,
  "AWS.KMS.Decrypt",
  (
    key: Key | AliasName,
  ) => Effect.Effect<
    (
      request: DecryptRequest,
    ) => Effect.Effect<kms.DecryptResponse, kms.DecryptError>
  >
> {}

export const Decrypt = Binding.Service<Decrypt>("AWS.KMS.Decrypt");
