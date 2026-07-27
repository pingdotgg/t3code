import type * as kms from "@distilled.cloud/aws/kms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AliasName } from "./Alias.ts";
import type { Key } from "./Key.ts";

export interface ReEncryptRequest extends Omit<
  kms.ReEncryptRequest,
  "DestinationKeyId" | "SourceKeyId"
> {}

/**
 * Runtime binding for `kms:ReEncrypt`.
 *
 * Re-encrypts a ciphertext under a new key (or a new encryption context)
 * entirely inside KMS — the plaintext never leaves the service. Bind the
 * destination KMS {@link Key} (or `alias/...` name), and optionally the
 * source key when migrating ciphertexts between keys:
 *
 * - `ReEncrypt(key)` — same-key re-encryption (e.g. rotating the encryption
 *   context). Grants `kms:ReEncryptFrom` + `kms:ReEncryptTo` on the key.
 * - `ReEncrypt(destination, source)` — cross-key migration. Grants
 *   `kms:ReEncryptTo` on the destination and `kms:ReEncryptFrom` on the
 *   source, and pins `SourceKeyId` in every request.
 *
 * @binding
 * @section Re-Encryption
 * @example Rotate the Encryption Context In Place
 * ```typescript
 * const reEncrypt = yield* AWS.KMS.ReEncrypt(key);
 *
 * const { CiphertextBlob } = yield* reEncrypt({
 *   CiphertextBlob: ciphertext,
 *   SourceEncryptionContext: { tenant: "alpha" },
 *   DestinationEncryptionContext: { tenant: "beta" },
 * });
 * ```
 *
 * @example Migrate Ciphertexts to a New Key
 * ```typescript
 * const reEncrypt = yield* AWS.KMS.ReEncrypt(newKey, oldKey);
 *
 * const { CiphertextBlob } = yield* reEncrypt({
 *   CiphertextBlob: legacyCiphertext,
 * });
 * ```
 */
export interface ReEncrypt extends Binding.Service<
  ReEncrypt,
  "AWS.KMS.ReEncrypt",
  (
    destination: Key | AliasName,
    source?: Key | AliasName,
  ) => Effect.Effect<
    (
      request: ReEncryptRequest,
    ) => Effect.Effect<kms.ReEncryptResponse, kms.ReEncryptError>
  >
> {}

export const ReEncrypt = Binding.Service<ReEncrypt>("AWS.KMS.ReEncrypt");
