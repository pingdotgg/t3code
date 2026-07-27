import type * as ecr from "@distilled.cloud/aws/ecr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link InitiateLayerUpload} — `repositoryName` is injected from the
 * bound {@link Repository} (the registry defaults to the caller's account).
 */
export interface InitiateLayerUploadRequest extends Omit<
  ecr.InitiateLayerUploadRequest,
  "registryId" | "repositoryName"
> {}

/**
 * Runtime binding for `ecr:InitiateLayerUpload`.
 *
 * Opens a layer-blob upload to the bound repository, returning the `uploadId` that `UploadLayerPart` and `CompleteLayerUpload` continue. Provide the implementation with
 * `Effect.provide(AWS.ECR.InitiateLayerUploadHttp)`.
 * @binding
 * @section Pushing Images
 * @example Start a Layer Upload
 * ```typescript
 * const initiateUpload = yield* AWS.ECR.InitiateLayerUpload(repository);
 *
 * const { uploadId } = yield* initiateUpload();
 * ```
 */
export interface InitiateLayerUpload extends Binding.Service<
  InitiateLayerUpload,
  "AWS.ECR.InitiateLayerUpload",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request?: InitiateLayerUploadRequest,
    ) => Effect.Effect<
      ecr.InitiateLayerUploadResponse,
      ecr.InitiateLayerUploadError
    >
  >
> {}

export const InitiateLayerUpload = Binding.Service<InitiateLayerUpload>(
  "AWS.ECR.InitiateLayerUpload",
);
