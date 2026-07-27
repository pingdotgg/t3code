import type * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PublicRepository } from "./Repository.ts";

/** Request for {@link PutImage} — `repositoryName` is injected. */
export interface PutImageRequest extends Omit<
  ecrpublic.PutImageRequest,
  "repositoryName"
> {}

/**
 * Runtime binding for `ecr-public:PutImage`.
 *
 * Creates or updates an image manifest in the bound
 * {@link PublicRepository} — the final step of an image push after all
 * referenced layers are uploaded ({@link InitiateLayerUpload} →
 * {@link UploadLayerPart} → {@link CompleteLayerUpload}). Provide the
 * implementation with `Effect.provide(AWS.ECRPublic.PutImageHttp)`.
 *
 * @binding
 * @section Pushing Images
 * @example Put An Image Manifest
 * ```typescript
 * // init
 * const putImage = yield* AWS.ECRPublic.PutImage(repository);
 *
 * // runtime
 * const result = yield* putImage({
 *   imageManifest: JSON.stringify(manifest),
 *   imageManifestMediaType: "application/vnd.oci.image.manifest.v1+json",
 *   imageTag: "latest",
 * });
 * ```
 */
export interface PutImage extends Binding.Service<
  PutImage,
  "AWS.ECRPublic.PutImage",
  <R extends PublicRepository>(
    repository: R,
  ) => Effect.Effect<
    (
      request: PutImageRequest,
    ) => Effect.Effect<ecrpublic.PutImageResponse, ecrpublic.PutImageError>
  >
> {}

export const PutImage = Binding.Service<PutImage>("AWS.ECRPublic.PutImage");
