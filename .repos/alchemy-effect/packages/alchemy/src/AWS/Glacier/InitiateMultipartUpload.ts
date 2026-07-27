import type * as glacier from "@distilled.cloud/aws/glacier";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Vault } from "./Vault.ts";

/**
 * `InitiateMultipartUpload` request with `accountId` and `vaultName` injected from the bound
 * {@link Vault}.
 */
export interface InitiateMultipartUploadRequest extends Omit<
  glacier.InitiateMultipartUploadInput,
  "accountId" | "vaultName"
> {}

/**
 * Runtime binding for the `InitiateMultipartUpload` operation (IAM action
 * `glacier:InitiateMultipartUpload` on the vault ARN).
 *
 * Starts a multipart upload to the bound {@link Vault} and returns the
 * `uploadId` to use with {@link UploadMultipartPart} and
 * {@link CompleteMultipartUpload}. `partSize` must be a power-of-two
 * multiple of 1 MiB (as a string of bytes).
 * Provide the implementation with
 * `Effect.provide(AWS.Glacier.InitiateMultipartUploadHttp)`.
 * @binding
 * @section Uploading Archives
 * @example Start a multipart upload
 * ```typescript
 * const initiateMultipartUpload =
 *   yield* AWS.Glacier.InitiateMultipartUpload(vault);
 *
 * const { uploadId } = yield* initiateMultipartUpload({
 *   archiveDescription: "large backup",
 *   partSize: String(8 * 1024 * 1024),
 * });
 * ```
 */
export interface InitiateMultipartUpload extends Binding.Service<
  InitiateMultipartUpload,
  "AWS.Glacier.InitiateMultipartUpload",
  (
    vault: Vault,
  ) => Effect.Effect<
    (
      request?: InitiateMultipartUploadRequest,
    ) => Effect.Effect<
      glacier.InitiateMultipartUploadOutput,
      glacier.InitiateMultipartUploadError
    >
  >
> {}
export const InitiateMultipartUpload = Binding.Service<InitiateMultipartUpload>(
  "AWS.Glacier.InitiateMultipartUpload",
);
