import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:UpdateEncryptionKey`.
 *
 * Updates an encryption key. A `ResourceNotFoundException` means that an
 * Amazon Web Services owned key is being used for encryption.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.UpdateEncryptionKeyHttp)`.
 * @binding
 * @section Account Settings & Usage
 * @example Use a Customer-Managed Key
 * ```typescript
 * // init
 * const updateEncryptionKey = yield* AWS.Inspector2.UpdateEncryptionKey();
 *
 * // runtime
 * yield* updateEncryptionKey({
 *   kmsKeyId,
 *   resourceType: "AWS_ECR_CONTAINER_IMAGE",
 *   scanType: "PACKAGE",
 * });
 * ```
 */
export interface UpdateEncryptionKey extends Binding.Service<
  UpdateEncryptionKey,
  "AWS.Inspector2.UpdateEncryptionKey",
  () => Effect.Effect<
    (
      request: inspector2.UpdateEncryptionKeyRequest,
    ) => Effect.Effect<
      inspector2.UpdateEncryptionKeyResponse,
      inspector2.UpdateEncryptionKeyError
    >
  >
> {}
export const UpdateEncryptionKey = Binding.Service<UpdateEncryptionKey>(
  "AWS.Inspector2.UpdateEncryptionKey",
);
