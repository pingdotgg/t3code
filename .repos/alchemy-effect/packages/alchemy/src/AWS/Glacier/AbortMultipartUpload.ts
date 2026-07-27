import type * as glacier from "@distilled.cloud/aws/glacier";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Vault } from "./Vault.ts";

/**
 * `AbortMultipartUpload` request with `accountId` and `vaultName` injected from the bound
 * {@link Vault}.
 */
export interface AbortMultipartUploadRequest extends Omit<
  glacier.AbortMultipartUploadInput,
  "accountId" | "vaultName"
> {}

/**
 * Runtime binding for the `AbortMultipartUpload` operation (IAM action
 * `glacier:AbortMultipartUpload` on the vault ARN).
 *
 * Aborts an in-progress multipart upload on the bound {@link Vault},
 * freeing its uploaded parts. Aborting an already-aborted or completed
 * upload fails with the typed `ResourceNotFoundException`.
 * Provide the implementation with
 * `Effect.provide(AWS.Glacier.AbortMultipartUploadHttp)`.
 * @binding
 * @section Uploading Archives
 * @example Abort an in-progress upload
 * ```typescript
 * const abortMultipartUpload = yield* AWS.Glacier.AbortMultipartUpload(vault);
 *
 * yield* abortMultipartUpload({ uploadId });
 * ```
 */
export interface AbortMultipartUpload extends Binding.Service<
  AbortMultipartUpload,
  "AWS.Glacier.AbortMultipartUpload",
  (
    vault: Vault,
  ) => Effect.Effect<
    (
      request: AbortMultipartUploadRequest,
    ) => Effect.Effect<
      glacier.AbortMultipartUploadResponse,
      glacier.AbortMultipartUploadError
    >
  >
> {}
export const AbortMultipartUpload = Binding.Service<AbortMultipartUpload>(
  "AWS.Glacier.AbortMultipartUpload",
);
