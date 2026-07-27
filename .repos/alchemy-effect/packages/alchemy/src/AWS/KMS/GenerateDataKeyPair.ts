import type * as kms from "@distilled.cloud/aws/kms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AliasName } from "./Alias.ts";
import type { Key } from "./Key.ts";

export interface GenerateDataKeyPairRequest extends Omit<
  kms.GenerateDataKeyPairRequest,
  "KeyId"
> {}

/**
 * Runtime binding for `kms:GenerateDataKeyPair`.
 *
 * Bind this operation to a symmetric-encryption KMS {@link Key} (or the
 * `alias/...` name of a pre-existing key) to get a callable that
 * automatically injects the `KeyId`. Returns a fresh asymmetric key pair:
 * the public key and plaintext private key for immediate local use, plus
 * the private key encrypted under the bound symmetric key for storage.
 *
 * The `PrivateKeyPlaintext` in the response is wrapped in `Redacted` so it
 * never leaks into logs — unwrap with `Redacted.value(...)` at the point of
 * use and discard it as soon as the local operation is done.
 *
 * @binding
 * @section Data Key Pairs
 * @example Generate an RSA Key Pair
 * ```typescript
 * const generateDataKeyPair = yield* AWS.KMS.GenerateDataKeyPair(key);
 *
 * const pair = yield* generateDataKeyPair({ KeyPairSpec: "RSA_2048" });
 * // pair.PublicKey            — DER-encoded public key
 * // pair.PrivateKeyPlaintext  — Redacted; use locally then discard
 * // pair.PrivateKeyCiphertextBlob — persist; recover via the Decrypt binding
 * ```
 */
export interface GenerateDataKeyPair extends Binding.Service<
  GenerateDataKeyPair,
  "AWS.KMS.GenerateDataKeyPair",
  (
    key: Key | AliasName,
  ) => Effect.Effect<
    (
      request: GenerateDataKeyPairRequest,
    ) => Effect.Effect<
      kms.GenerateDataKeyPairResponse,
      kms.GenerateDataKeyPairError
    >
  >
> {}

export const GenerateDataKeyPair = Binding.Service<GenerateDataKeyPair>(
  "AWS.KMS.GenerateDataKeyPair",
);
