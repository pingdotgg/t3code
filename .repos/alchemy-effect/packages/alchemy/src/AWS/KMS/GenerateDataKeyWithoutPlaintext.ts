import type * as kms from "@distilled.cloud/aws/kms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AliasName } from "./Alias.ts";
import type { Key } from "./Key.ts";

export interface GenerateDataKeyWithoutPlaintextRequest extends Omit<
  kms.GenerateDataKeyWithoutPlaintextRequest,
  "KeyId"
> {}

/**
 * Runtime binding for `kms:GenerateDataKeyWithoutPlaintext`.
 *
 * Bind this operation to a KMS {@link Key} (or the `alias/...` name of a
 * pre-existing key) to get a callable that automatically injects the
 * `KeyId`. Returns ONLY the encrypted copy of a fresh data key — use it in
 * the component that provisions envelope keys but must never see key
 * material; the consumer decrypts the blob later with the `Decrypt` binding.
 *
 * @binding
 * @section Envelope Encryption
 * @example Provision a Data Key Without Seeing It
 * ```typescript
 * const generateDataKeyWithoutPlaintext =
 *   yield* AWS.KMS.GenerateDataKeyWithoutPlaintext(key);
 *
 * const { CiphertextBlob } = yield* generateDataKeyWithoutPlaintext({
 *   KeySpec: "AES_256",
 * });
 * // store CiphertextBlob next to the data; no plaintext ever existed here
 * ```
 *
 * @section Pre-Existing Keys
 * @example Bind by Alias Name
 * ```typescript
 * const generate = yield* AWS.KMS.GenerateDataKeyWithoutPlaintext("alias/app-key");
 * ```
 */
export interface GenerateDataKeyWithoutPlaintext extends Binding.Service<
  GenerateDataKeyWithoutPlaintext,
  "AWS.KMS.GenerateDataKeyWithoutPlaintext",
  (
    key: Key | AliasName,
  ) => Effect.Effect<
    (
      request: GenerateDataKeyWithoutPlaintextRequest,
    ) => Effect.Effect<
      kms.GenerateDataKeyWithoutPlaintextResponse,
      kms.GenerateDataKeyWithoutPlaintextError
    >
  >
> {}

export const GenerateDataKeyWithoutPlaintext =
  Binding.Service<GenerateDataKeyWithoutPlaintext>(
    "AWS.KMS.GenerateDataKeyWithoutPlaintext",
  );
