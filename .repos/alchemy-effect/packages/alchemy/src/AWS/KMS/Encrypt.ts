import type * as kms from "@distilled.cloud/aws/kms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AliasName } from "./Alias.ts";
import type { Key } from "./Key.ts";

export interface EncryptRequest extends Omit<kms.EncryptRequest, "KeyId"> {}

/**
 * Runtime binding for `kms:Encrypt`.
 *
 * Bind this operation to a KMS {@link Key} (or the `alias/...` name of a
 * pre-existing key) inside a function runtime to get a callable that
 * automatically injects the `KeyId`. Payloads are raw `Uint8Array`s — the
 * distilled client handles base64 wire encoding transparently.
 *
 * IAM is scoped to least privilege: the exact key ARN for a `Key` resource,
 * or the `kms:RequestAlias` condition for an alias name.
 *
 * @binding
 * @section Encrypting Data
 * @example Encrypt a Payload
 * ```typescript
 * const encrypt = yield* AWS.KMS.Encrypt(key);
 *
 * const response = yield* encrypt({
 *   Plaintext: new TextEncoder().encode("attack at dawn"),
 * });
 * // response.CiphertextBlob is a Uint8Array
 * ```
 *
 * @example Encrypt with an Encryption Context
 * ```typescript
 * const response = yield* encrypt({
 *   Plaintext: payload,
 *   EncryptionContext: { tenant: "acme" },
 * });
 * ```
 *
 * @section Pre-Existing Keys
 * @example Bind by Alias Name
 * ```typescript
 * // Uses a key managed outside this stack; IAM is scoped via kms:RequestAlias.
 * const encrypt = yield* AWS.KMS.Encrypt("alias/app-key");
 * ```
 *
 * @section Wiring
 * @example Provide the Implementation on a Lambda Function
 * ```typescript
 * // Bind in the init phase, call in the handler, and provide the
 * // EncryptHttp layer on the Function's init Effect (merge the other
 * // KMS layers with Layer.mergeAll when using several bindings).
 * export default CryptoFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     const key = yield* AWS.KMS.Key("AppKey");
 *     const encrypt = yield* AWS.KMS.Encrypt(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const body = yield* request.text;
 *         const { CiphertextBlob } = yield* encrypt({
 *           Plaintext: new TextEncoder().encode(body),
 *         });
 *         return HttpServerResponse.json({
 *           ciphertext: Buffer.from(CiphertextBlob!).toString("base64"),
 *         });
 *       }),
 *     };
 *   }).pipe(Effect.provide(AWS.KMS.EncryptHttp)),
 * );
 * ```
 */
export interface Encrypt extends Binding.Service<
  Encrypt,
  "AWS.KMS.Encrypt",
  (
    key: Key | AliasName,
  ) => Effect.Effect<
    (
      request: EncryptRequest,
    ) => Effect.Effect<kms.EncryptResponse, kms.EncryptError>
  >
> {}

export const Encrypt = Binding.Service<Encrypt>("AWS.KMS.Encrypt");
