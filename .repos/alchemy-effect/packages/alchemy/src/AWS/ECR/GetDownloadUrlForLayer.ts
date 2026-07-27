import type * as ecr from "@distilled.cloud/aws/ecr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link GetDownloadUrlForLayer} — `repositoryName` is injected from the
 * bound {@link Repository} (the registry defaults to the caller's account).
 */
export interface GetDownloadUrlForLayerRequest extends Omit<
  ecr.GetDownloadUrlForLayerRequest,
  "registryId" | "repositoryName"
> {}

/**
 * Runtime binding for `ecr:GetDownloadUrlForLayer`.
 *
 * Resolves a pre-signed S3 download URL for an image layer in the bound repository — the blob-download half of a registry pull. Provide the implementation with
 * `Effect.provide(AWS.ECR.GetDownloadUrlForLayerHttp)`.
 * @binding
 * @section Pulling Images
 * @example Download a Layer Blob
 * ```typescript
 * const getDownloadUrl = yield* AWS.ECR.GetDownloadUrlForLayer(repository);
 *
 * const res = yield* getDownloadUrl({ layerDigest: "sha256:…" });
 * console.log(res.downloadUrl);
 * ```
 */
export interface GetDownloadUrlForLayer extends Binding.Service<
  GetDownloadUrlForLayer,
  "AWS.ECR.GetDownloadUrlForLayer",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: GetDownloadUrlForLayerRequest,
    ) => Effect.Effect<
      ecr.GetDownloadUrlForLayerResponse,
      ecr.GetDownloadUrlForLayerError
    >
  >
> {}

export const GetDownloadUrlForLayer = Binding.Service<GetDownloadUrlForLayer>(
  "AWS.ECR.GetDownloadUrlForLayer",
);
