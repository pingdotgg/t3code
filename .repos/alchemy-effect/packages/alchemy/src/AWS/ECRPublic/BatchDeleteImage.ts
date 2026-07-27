import type * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PublicRepository } from "./Repository.ts";

/** Request for {@link BatchDeleteImage} — `repositoryName` is injected. */
export interface BatchDeleteImageRequest extends Omit<
  ecrpublic.BatchDeleteImageRequest,
  "repositoryName"
> {}

/**
 * Runtime binding for `ecr-public:BatchDeleteImage`.
 *
 * Deletes images (by tag or digest) from the bound
 * {@link PublicRepository}. Per-image failures (e.g. `ImageNotFound`) are
 * reported in the response's `failures` list, not as errors. Provide the
 * implementation with `Effect.provide(AWS.ECRPublic.BatchDeleteImageHttp)`.
 *
 * @binding
 * @section Deleting Images
 * @example Delete An Image By Tag
 * ```typescript
 * // init
 * const batchDeleteImage = yield* AWS.ECRPublic.BatchDeleteImage(repository);
 *
 * // runtime
 * const result = yield* batchDeleteImage({
 *   imageIds: [{ imageTag: "stale" }],
 * });
 * ```
 */
export interface BatchDeleteImage extends Binding.Service<
  BatchDeleteImage,
  "AWS.ECRPublic.BatchDeleteImage",
  <R extends PublicRepository>(
    repository: R,
  ) => Effect.Effect<
    (
      request: BatchDeleteImageRequest,
    ) => Effect.Effect<
      ecrpublic.BatchDeleteImageResponse,
      ecrpublic.BatchDeleteImageError
    >
  >
> {}

export const BatchDeleteImage = Binding.Service<BatchDeleteImage>(
  "AWS.ECRPublic.BatchDeleteImage",
);
