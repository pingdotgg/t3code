import type * as ecr from "@distilled.cloud/aws/ecr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link UploadLayerPart} — `repositoryName` is injected from the
 * bound {@link Repository} (the registry defaults to the caller's account).
 */
export interface UploadLayerPartRequest extends Omit<
  ecr.UploadLayerPartRequest,
  "registryId" | "repositoryName"
> {}

/**
 * Runtime binding for `ecr:UploadLayerPart`.
 *
 * Uploads one chunk of a layer blob to an open upload in the bound repository (non-final parts must be at least 5 MiB). Provide the implementation with
 * `Effect.provide(AWS.ECR.UploadLayerPartHttp)`.
 * @binding
 * @section Pushing Images
 * @example Upload a Single-Part Layer
 * ```typescript
 * const uploadPart = yield* AWS.ECR.UploadLayerPart(repository);
 *
 * yield* uploadPart({
 *   uploadId: uploadId!,
 *   partFirstByte: 0,
 *   partLastByte: blob.length - 1,
 *   layerPartBlob: blob,
 * });
 * ```
 */
export interface UploadLayerPart extends Binding.Service<
  UploadLayerPart,
  "AWS.ECR.UploadLayerPart",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: UploadLayerPartRequest,
    ) => Effect.Effect<ecr.UploadLayerPartResponse, ecr.UploadLayerPartError>
  >
> {}

export const UploadLayerPart = Binding.Service<UploadLayerPart>(
  "AWS.ECR.UploadLayerPart",
);
