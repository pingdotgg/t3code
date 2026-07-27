import type * as ecr from "@distilled.cloud/aws/ecr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link DescribeImages} — `repositoryName` is injected from the
 * bound {@link Repository} (the registry defaults to the caller's account).
 */
export interface DescribeImagesRequest extends Omit<
  ecr.DescribeImagesRequest,
  "registryId" | "repositoryName"
> {}

/**
 * Runtime binding for `ecr:DescribeImages`.
 *
 * Returns metadata (digest, tags, size, push time, scan status) about the images in the bound repository. Provide the implementation with
 * `Effect.provide(AWS.ECR.DescribeImagesHttp)`.
 * @binding
 * @section Reading Images
 * @example Describe Tagged Images
 * ```typescript
 * const describeImages = yield* AWS.ECR.DescribeImages(repository);
 *
 * const res = yield* describeImages({ imageIds: [{ imageTag: "latest" }] });
 * console.log(res.imageDetails?.[0]?.imageDigest);
 * ```
 */
export interface DescribeImages extends Binding.Service<
  DescribeImages,
  "AWS.ECR.DescribeImages",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request?: DescribeImagesRequest,
    ) => Effect.Effect<ecr.DescribeImagesResponse, ecr.DescribeImagesError>
  >
> {}

export const DescribeImages = Binding.Service<DescribeImages>(
  "AWS.ECR.DescribeImages",
);
