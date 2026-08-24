import type * as kms from "@distilled.cloud/aws/kms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AliasName } from "./Alias.ts";
import type { Key } from "./Key.ts";

export interface GenerateDataKeyPairWithoutPlaintextRequest extends Omit<
  kms.GenerateDataKeyPairWithoutPlaintextRequest,
  "KeyId"
> {}

/**
 * Runtime binding for `kms:GenerateDataKeyPairWithoutPlaintext`.
 *
 * Bind this operation to a symmetric-encryption KMS {@link Key} (or the
 * `alias/...` name of a pre-existing key) to get a callable that
 * automatically injects the `KeyId`. Returns the public key and the private
 * key encrypted under the bound symmetric key — the plaintext private key
 * never exists in this process; decrypt the blob later with the `Decrypt`
 * binding where it is actually needed.
 *
 * @binding
 * @section Data Key Pairs
 * @example Provision a Key Pair Without the Private Key
 * ```typescript
 * const generatePair = yield* AWS.KMS.GenerateDataKeyPairWithoutPlaintext(key);
 *
 * const pair = yield* generatePair({ KeyPairSpec: "ECC_NIST_P256" });
 * // pair.PublicKey                — hand out for encryption/verification
 * // pair.PrivateKeyCiphertextBlob — persist for the consuming service
 * ```
 */
export interface GenerateDataKeyPairWithoutPlaintext extends Binding.Service<
  GenerateDataKeyPairWithoutPlaintext,
  "AWS.KMS.GenerateDataKeyPairWithoutPlaintext",
  (
    key: Key | AliasName,
  ) => Effect.Effect<
    (
      request: GenerateDataKeyPairWithoutPlaintextRequest,
    ) => Effect.Effect<
      kms.GenerateDataKeyPairWithoutPlaintextResponse,
      kms.GenerateDataKeyPairWithoutPlaintextError
    >
  >
> {}

export const GenerateDataKeyPairWithoutPlaintext =
  Binding.Service<GenerateDataKeyPairWithoutPlaintext>(
    "AWS.KMS.GenerateDataKeyPairWithoutPlaintext",
  );
