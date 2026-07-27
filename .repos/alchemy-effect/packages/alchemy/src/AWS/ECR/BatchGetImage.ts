import type * as ecr from "@distilled.cloud/aws/ecr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link BatchGetImage} — `repositoryName` is injected from the
 * bound {@link Repository} (the registry defaults to the caller's account).
 */
export interface BatchGetImageRequest extends Omit<
  ecr.BatchGetImageRequest,
  "registryId" | "repositoryName"
> {}

/**
 * Runtime binding for `ecr:BatchGetImage`.
 *
 * Fetches image manifests from the bound repository — the read half of a registry pull, and the first step of re-tagging an image (`BatchGetImage` → `PutImage` with a new tag). Provide the implementation with
 * `Effect.provide(AWS.ECR.BatchGetImageHttp)`.
 * @binding
 * @section Pulling Images
 * @example Fetch an Image Manifest
 * ```typescript
 * const batchGetImage = yield* AWS.ECR.BatchGetImage(repository);
 *
 * const res = yield* batchGetImage({ imageIds: [{ imageTag: "latest" }] });
 * const manifest = res.images?.[0]?.imageManifest;
 * ```
 */
export interface BatchGetImage extends Binding.Service<
  BatchGetImage,
  "AWS.ECR.BatchGetImage",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: BatchGetImageRequest,
    ) => Effect.Effect<ecr.BatchGetImageResponse, ecr.BatchGetImageError>
  >
> {}

export const BatchGetImage = Binding.Service<BatchGetImage>(
  "AWS.ECR.BatchGetImage",
);
