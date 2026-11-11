import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `inspector2:ResetEncryptionKey`.
 *
 * Resets an encryption key. After the key is reset your resources will be encrypted by an
 * Amazon Web Services owned key.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.ResetEncryptionKeyHttp)`.
 * ### Account Settings & Usage
 * **Example:** Reset to the AWS-Owned Key
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
 *
 * @binding
 */
export interface ResetEncryptionKey extends Binding.Service<
  ResetEncryptionKey,
  "AWS.Inspector2.ResetEncryptionKey",
  () => Effect.Effect<
    (
      request: inspector2.ResetEncryptionKeyRequest,
    ) => Effect.Effect<inspector2.ResetEncryptionKeyResponse, inspector2.ResetEncryptionKeyError>
  >
> {}
export const ResetEncryptionKey = Binding.Service<ResetEncryptionKey>(
  "AWS.Inspector2.ResetEncryptionKey",
);
