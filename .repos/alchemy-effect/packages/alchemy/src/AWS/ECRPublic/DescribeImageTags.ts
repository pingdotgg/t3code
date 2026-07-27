import type * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PublicRepository } from "./Repository.ts";

/** Request for {@link DescribeImageTags} — `repositoryName` is injected. */
export interface DescribeImageTagsRequest extends Omit<
  ecrpublic.DescribeImageTagsRequest,
  "repositoryName"
> {}

/**
 * Runtime binding for `ecr-public:DescribeImageTags`.
 *
 * Lists the tag details (tag, digest, push time) for the images in the
 * bound {@link PublicRepository}. Provide the implementation with
 * `Effect.provide(AWS.ECRPublic.DescribeImageTagsHttp)`.
 *
 * @binding
 * @section Reading Images
 * @example List Image Tags
 * ```typescript
 * // init
 * const describeImageTags = yield* AWS.ECRPublic.DescribeImageTags(repository);
 *
 * // runtime
 * const result = yield* describeImageTags();
 * const tags = (result.imageTagDetails ?? []).map((t) => t.imageTag);
 * ```
 */
export interface DescribeImageTags extends Binding.Service<
  DescribeImageTags,
  "AWS.ECRPublic.DescribeImageTags",
  <R extends PublicRepository>(
    repository: R,
  ) => Effect.Effect<
    (
      request?: DescribeImageTagsRequest,
    ) => Effect.Effect<
      ecrpublic.DescribeImageTagsResponse,
      ecrpublic.DescribeImageTagsError
    >
  >
> {}

export const DescribeImageTags = Binding.Service<DescribeImageTags>(
  "AWS.ECRPublic.DescribeImageTags",
);
