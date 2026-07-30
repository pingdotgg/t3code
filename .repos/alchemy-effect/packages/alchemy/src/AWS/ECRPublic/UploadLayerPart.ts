import type * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PublicRepository } from "./Repository.ts";

/** Request for {@link UploadLayerPart} — `repositoryName` is injected. */
export interface UploadLayerPartRequest extends Omit<
  ecrpublic.UploadLayerPartRequest,
  "repositoryName"
> {}

/**
 * Runtime binding for `ecr-public:UploadLayerPart`.
 *
 * Uploads one chunk of an in-flight image layer upload to the bound
 * {@link PublicRepository}. Provide the implementation with
 * `Effect.provide(AWS.ECRPublic.UploadLayerPartHttp)`.
 *
 * @binding
 * @section Pushing Images
 * @example Upload A Layer Part
 * ```typescript
 * // init
 * const uploadLayerPart = yield* AWS.ECRPublic.UploadLayerPart(repository);
 *
 * // runtime
 * yield* uploadLayerPart({
 *   uploadId,
 *   partFirstByte: 0,
 *   partLastByte: blob.byteLength - 1,
 *   layerPartBlob: blob,
 * });
 * ```
 */
export interface UploadLayerPart extends Binding.Service<
  UploadLayerPart,
  "AWS.ECRPublic.UploadLayerPart",
  <R extends PublicRepository>(
    repository: R,
  ) => Effect.Effect<
    (
      request: UploadLayerPartRequest,
    ) => Effect.Effect<
      ecrpublic.UploadLayerPartResponse,
      ecrpublic.UploadLayerPartError
    >
  >
> {}

export const UploadLayerPart = Binding.Service<UploadLayerPart>(
  "AWS.ECRPublic.UploadLayerPart",
);
