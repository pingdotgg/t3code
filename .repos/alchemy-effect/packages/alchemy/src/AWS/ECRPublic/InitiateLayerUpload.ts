import type * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PublicRepository } from "./Repository.ts";

/** Request for {@link InitiateLayerUpload} — `repositoryName` is injected. */
export interface InitiateLayerUploadRequest extends Omit<
  ecrpublic.InitiateLayerUploadRequest,
  "repositoryName"
> {}

/**
 * Runtime binding for `ecr-public:InitiateLayerUpload`.
 *
 * Starts an image layer upload to the bound {@link PublicRepository},
 * returning the `uploadId` used by {@link UploadLayerPart} and
 * {@link CompleteLayerUpload}. Provide the implementation with
 * `Effect.provide(AWS.ECRPublic.InitiateLayerUploadHttp)`.
 *
 * @binding
 * @section Pushing Images
 * @example Start A Layer Upload
 * ```typescript
 * // init
 * const initiateLayerUpload = yield* AWS.ECRPublic.InitiateLayerUpload(repository);
 *
 * // runtime
 * const { uploadId } = yield* initiateLayerUpload();
 * ```
 */
export interface InitiateLayerUpload extends Binding.Service<
  InitiateLayerUpload,
  "AWS.ECRPublic.InitiateLayerUpload",
  <R extends PublicRepository>(
    repository: R,
  ) => Effect.Effect<
    (
      request?: InitiateLayerUploadRequest,
    ) => Effect.Effect<
      ecrpublic.InitiateLayerUploadResponse,
      ecrpublic.InitiateLayerUploadError
    >
  >
> {}

export const InitiateLayerUpload = Binding.Service<InitiateLayerUpload>(
  "AWS.ECRPublic.InitiateLayerUpload",
);
