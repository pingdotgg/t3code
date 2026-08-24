import type * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PublicRepository } from "./Repository.ts";

/** Request for {@link CompleteLayerUpload} — `repositoryName` is injected. */
export interface CompleteLayerUploadRequest extends Omit<
  ecrpublic.CompleteLayerUploadRequest,
  "repositoryName"
> {}

/**
 * Runtime binding for `ecr-public:CompleteLayerUpload`.
 *
 * Seals an in-flight layer upload in the bound {@link PublicRepository},
 * validating the uploaded bytes against the provided `sha256` digest.
 * Provide the implementation with
 * `Effect.provide(AWS.ECRPublic.CompleteLayerUploadHttp)`.
 *
 * @binding
 * @section Pushing Images
 * @example Complete A Layer Upload
 * ```typescript
 * // init
 * const completeLayerUpload = yield* AWS.ECRPublic.CompleteLayerUpload(repository);
 *
 * // runtime
 * const { layerDigest } = yield* completeLayerUpload({
 *   uploadId,
 *   layerDigests: [digest],
 * });
 * ```
 */
export interface CompleteLayerUpload extends Binding.Service<
  CompleteLayerUpload,
  "AWS.ECRPublic.CompleteLayerUpload",
  <R extends PublicRepository>(
    repository: R,
  ) => Effect.Effect<
    (
      request: CompleteLayerUploadRequest,
    ) => Effect.Effect<
      ecrpublic.CompleteLayerUploadResponse,
      ecrpublic.CompleteLayerUploadError
    >
  >
> {}

export const CompleteLayerUpload = Binding.Service<CompleteLayerUpload>(
  "AWS.ECRPublic.CompleteLayerUpload",
);
