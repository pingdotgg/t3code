import type * as glacier from "@distilled.cloud/aws/glacier";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Vault } from "./Vault.ts";

/**
 * `CompleteMultipartUpload` request with `accountId` and `vaultName` injected from the bound
 * {@link Vault}.
 */
export interface CompleteMultipartUploadRequest extends Omit<
  glacier.CompleteMultipartUploadInput,
  "accountId" | "vaultName"
> {}

/**
 * Runtime binding for the `CompleteMultipartUpload` operation (IAM action
 * `glacier:CompleteMultipartUpload` on the vault ARN).
 *
 * Assembles the uploaded parts of a multipart upload into an archive in
 * the bound {@link Vault}. `archiveSize` is the total size in bytes (as a
 * string) and `checksum` the SHA-256 tree hash of the whole archive; the
 * response carries the new `archiveId`.
 * Provide the implementation with
 * `Effect.provide(AWS.Glacier.CompleteMultipartUploadHttp)`.
 * @binding
 * @section Uploading Archives
 * @example Complete a multipart upload
 * ```typescript
 * const completeMultipartUpload =
 *   yield* AWS.Glacier.CompleteMultipartUpload(vault);
 *
 * const { archiveId } = yield* completeMultipartUpload({
 *   uploadId,
 *   archiveSize: String(totalSize),
 *   checksum: treeHash,
 * });
 * ```
 */
export interface CompleteMultipartUpload extends Binding.Service<
  CompleteMultipartUpload,
  "AWS.Glacier.CompleteMultipartUpload",
  (
    vault: Vault,
  ) => Effect.Effect<
    (
      request: CompleteMultipartUploadRequest,
    ) => Effect.Effect<
      glacier.ArchiveCreationOutput,
      glacier.CompleteMultipartUploadError
    >
  >
> {}
export const CompleteMultipartUpload = Binding.Service<CompleteMultipartUpload>(
  "AWS.Glacier.CompleteMultipartUpload",
);
