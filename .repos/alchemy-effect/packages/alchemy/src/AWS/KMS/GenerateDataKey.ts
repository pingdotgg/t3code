import type * as kms from "@distilled.cloud/aws/kms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AliasName } from "./Alias.ts";
import type { Key } from "./Key.ts";

export interface GenerateDataKeyRequest extends Omit<
  kms.GenerateDataKeyRequest,
  "KeyId"
> {}

/**
 * Runtime binding for `kms:GenerateDataKey`.
 *
 * Bind this operation to a KMS {@link Key} (or the `alias/...` name of a
 * pre-existing key) inside a function runtime to get a callable that
 * automatically injects the `KeyId`. Returns a fresh symmetric data key as
 * both plaintext (for immediate envelope encryption outside KMS) and a
 * ciphertext blob encrypted under the bound key (for storage alongside the
 * data). Decrypt the stored blob later with the `Decrypt` binding.
 *
 * The `Plaintext` data key in the response is wrapped in `Redacted` so it
 * never leaks into logs — unwrap with `Redacted.value(...)` at the point of
 * use and discard it as soon as the envelope operation is done.
 *
 * @binding
 * @section Envelope Encryption
 * @example Generate a Data Key
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * const generateDataKey = yield* AWS.KMS.GenerateDataKey(key);
 *
 * const response = yield* generateDataKey({ KeySpec: "AES_256" });
 * const dataKey = Redacted.isRedacted(response.Plaintext)
 *   ? Redacted.value(response.Plaintext)
 *   : response.Plaintext; // 32-byte Uint8Array — use, then discard
 * const stored = response.CiphertextBlob; // persist next to the data
 * ```
 *
 * @example Recover the Data Key Later
 * ```typescript
 * const decrypt = yield* AWS.KMS.Decrypt(key);
 * const recovered = yield* decrypt({ CiphertextBlob: stored });
 * ```
 *
 * @section Pre-Existing Keys
 * @example Bind by Alias Name
 * ```typescript
 * const generateDataKey = yield* AWS.KMS.GenerateDataKey("alias/app-key");
 * ```
 *
 * @section Wiring
 * @example Provide the Implementation on a Lambda Function
 * ```typescript
 * // Envelope encryption pairs GenerateDataKey with Decrypt — provide
 * // both HTTP layers on the Function's init Effect.
 * export default EnvelopeFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     const key = yield* AWS.KMS.Key("DataKey");
 *     const generateDataKey = yield* AWS.KMS.GenerateDataKey(key);
 *     const decrypt = yield* AWS.KMS.Decrypt(key);
 *     // ... generate a data key, encrypt locally, store the CiphertextBlob
 *     return { fetch: handler };
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(AWS.KMS.GenerateDataKeyHttp, AWS.KMS.DecryptHttp),
 *     ),
 *   ),
 * );
 * ```
 */
export interface GenerateDataKey extends Binding.Service<
  GenerateDataKey,
  "AWS.KMS.GenerateDataKey",
  (
    key: Key | AliasName,
  ) => Effect.Effect<
    (
      request: GenerateDataKeyRequest,
    ) => Effect.Effect<kms.GenerateDataKeyResponse, kms.GenerateDataKeyError>
  >
> {}

export const GenerateDataKey = Binding.Service<GenerateDataKey>(
  "AWS.KMS.GenerateDataKey",
);
