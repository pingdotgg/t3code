import type * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PublicRepository } from "./Repository.ts";

/** Request for {@link DescribeImages} — `repositoryName` is injected. */
export interface DescribeImagesRequest extends Omit<
  ecrpublic.DescribeImagesRequest,
  "repositoryName"
> {}

/**
 * Runtime binding for `ecr-public:DescribeImages`.
 *
 * Lists metadata (digest, tags, size, push time) for the images in the
 * bound {@link PublicRepository}. Provide the implementation with
 * `Effect.provide(AWS.ECRPublic.DescribeImagesHttp)`.
 *
 * @binding
 * @section Reading Images
 * @example List Images In A Public Repository
 * ```typescript
 * // init
 * const describeImages = yield* AWS.ECRPublic.DescribeImages(repository);
 *
 * // runtime
 * const result = yield* describeImages();
 * const digests = (result.imageDetails ?? []).map((i) => i.imageDigest);
 * ```
 */
export interface DescribeImages extends Binding.Service<
  DescribeImages,
  "AWS.ECRPublic.DescribeImages",
  <R extends PublicRepository>(
    repository: R,
  ) => Effect.Effect<
    (
      request?: DescribeImagesRequest,
    ) => Effect.Effect<
      ecrpublic.DescribeImagesResponse,
      ecrpublic.DescribeImagesError
    >
  >
> {}

export const DescribeImages = Binding.Service<DescribeImages>(
  "AWS.ECRPublic.DescribeImages",
);
