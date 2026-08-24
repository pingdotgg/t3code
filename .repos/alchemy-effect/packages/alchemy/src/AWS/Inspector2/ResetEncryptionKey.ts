import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:ResetEncryptionKey`.
 *
 * Resets an encryption key. After the key is reset your resources will be encrypted by an
 * Amazon Web Services owned key.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.ResetEncryptionKeyHttp)`.
 * @binding
 * @section Account Settings & Usage
 * @example Reset to the AWS-Owned Key
 * ```typescript
 * // init
 * const resetEncryptionKey = yield* AWS.Inspector2.ResetEncryptionKey();
 *
 * // runtime
 * yield* resetEncryptionKey({
 *   resourceType: "AWS_ECR_CONTAINER_IMAGE",
 *   scanType: "PACKAGE",
 * });
 * ```
 */
export interface ResetEncryptionKey extends Binding.Service<
  ResetEncryptionKey,
  "AWS.Inspector2.ResetEncryptionKey",
  () => Effect.Effect<
    (
      request: inspector2.ResetEncryptionKeyRequest,
    ) => Effect.Effect<
      inspector2.ResetEncryptionKeyResponse,
      inspector2.ResetEncryptionKeyError
    >
  >
> {}
export const ResetEncryptionKey = Binding.Service<ResetEncryptionKey>(
  "AWS.Inspector2.ResetEncryptionKey",
);
