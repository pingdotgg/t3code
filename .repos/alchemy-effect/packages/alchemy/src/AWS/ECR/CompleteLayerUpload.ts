import type * as ecr from "@distilled.cloud/aws/ecr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link CompleteLayerUpload} — `repositoryName` is injected from the
 * bound {@link Repository} (the registry defaults to the caller's account).
 */
export interface CompleteLayerUploadRequest extends Omit<
  ecr.CompleteLayerUploadRequest,
  "registryId" | "repositoryName"
> {}

/**
 * Runtime binding for `ecr:CompleteLayerUpload`.
 *
 * Seals an open layer upload in the bound repository; ECR verifies the uploaded bytes against the supplied sha256 digest. Provide the implementation with
 * `Effect.provide(AWS.ECR.CompleteLayerUploadHttp)`.
 * @binding
 * @section Pushing Images
 * @example Finish a Layer Upload
 * ```typescript
 * const completeUpload = yield* AWS.ECR.CompleteLayerUpload(repository);
 *
 * yield* completeUpload({
 *   uploadId: uploadId!,
 *   layerDigests: [`sha256:${sha256HexOfBlob}`],
 * });
 * ```
 */
export interface CompleteLayerUpload extends Binding.Service<
  CompleteLayerUpload,
  "AWS.ECR.CompleteLayerUpload",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: CompleteLayerUploadRequest,
    ) => Effect.Effect<
      ecr.CompleteLayerUploadResponse,
      ecr.CompleteLayerUploadError
    >
  >
> {}

export const CompleteLayerUpload = Binding.Service<CompleteLayerUpload>(
  "AWS.ECR.CompleteLayerUpload",
);
