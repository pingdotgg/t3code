import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:GetEncryptionKey`.
 *
 * Gets an encryption key.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.GetEncryptionKeyHttp)`.
 * @binding
 * @section Account Settings & Usage
 * @example Read the CMK for a Scan Type
 * ```typescript
 * // init
 * const getEncryptionKey = yield* AWS.Inspector2.GetEncryptionKey();
 *
 * // runtime
 * const { kmsKeyId } = yield* getEncryptionKey({
 *   resourceType: "AWS_ECR_CONTAINER_IMAGE",
 *   scanType: "PACKAGE",
 * });
 * ```
 */
export interface GetEncryptionKey extends Binding.Service<
  GetEncryptionKey,
  "AWS.Inspector2.GetEncryptionKey",
  () => Effect.Effect<
    (
      request: inspector2.GetEncryptionKeyRequest,
    ) => Effect.Effect<
      inspector2.GetEncryptionKeyResponse,
      inspector2.GetEncryptionKeyError
    >
  >
> {}
export const GetEncryptionKey = Binding.Service<GetEncryptionKey>(
  "AWS.Inspector2.GetEncryptionKey",
);
