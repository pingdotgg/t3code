import type * as ecr from "@distilled.cloud/aws/ecr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link PutImage} — `repositoryName` is injected from the
 * bound {@link Repository} (the registry defaults to the caller's account).
 */
export interface PutImageRequest extends Omit<
  ecr.PutImageRequest,
  "registryId" | "repositoryName"
> {}

/**
 * Runtime binding for `ecr:PutImage`.
 *
 * Writes an image manifest to the bound repository — the final step of a push, and the write half of re-tagging (`BatchGetImage` → `PutImage` with a new tag). Provide the implementation with
 * `Effect.provide(AWS.ECR.PutImageHttp)`.
 * @binding
 * @section Pushing Images
 * @example Re-tag an Existing Image
 * ```typescript
 * const batchGetImage = yield* AWS.ECR.BatchGetImage(repository);
 * const putImage = yield* AWS.ECR.PutImage(repository);
 *
 * const res = yield* batchGetImage({ imageIds: [{ imageTag: "latest" }] });
 * yield* putImage({
 *   imageManifest: res.images![0]!.imageManifest!,
 *   imageTag: "stable",
 * });
 * ```
 */
export interface PutImage extends Binding.Service<
  PutImage,
  "AWS.ECR.PutImage",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: PutImageRequest,
    ) => Effect.Effect<ecr.PutImageResponse, ecr.PutImageError>
  >
> {}

export const PutImage = Binding.Service<PutImage>("AWS.ECR.PutImage");
