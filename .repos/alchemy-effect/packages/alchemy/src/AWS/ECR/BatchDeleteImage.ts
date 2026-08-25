import type * as ecr from "@distilled.cloud/aws/ecr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link BatchDeleteImage} — `repositoryName` is injected from the
 * bound {@link Repository} (the registry defaults to the caller's account).
 */
export interface BatchDeleteImageRequest extends Omit<
  ecr.BatchDeleteImageRequest,
  "registryId" | "repositoryName"
> {}

/**
 * Runtime binding for `ecr:BatchDeleteImage`.
 *
 * Deletes images (by tag or digest) from the bound repository. Missing images are reported in the response's `failures` array rather than as an error, so deletion is naturally idempotent. Provide the implementation with
 * `Effect.provide(AWS.ECR.BatchDeleteImageHttp)`.
 * @binding
 * @section Deleting Images
 * @example Delete an Image Tag
 * ```typescript
 * const batchDeleteImage = yield* AWS.ECR.BatchDeleteImage(repository);
 *
 * const res = yield* batchDeleteImage({ imageIds: [{ imageTag: "stale" }] });
 * console.log(res.imageIds?.length, "deleted");
 * ```
 */
export interface BatchDeleteImage extends Binding.Service<
  BatchDeleteImage,
  "AWS.ECR.BatchDeleteImage",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: BatchDeleteImageRequest,
    ) => Effect.Effect<ecr.BatchDeleteImageResponse, ecr.BatchDeleteImageError>
  >
> {}

export const BatchDeleteImage = Binding.Service<BatchDeleteImage>(
  "AWS.ECR.BatchDeleteImage",
);
