import type * as ecr from "@distilled.cloud/aws/ecr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link ListImages} — `repositoryName` is injected from the
 * bound {@link Repository} (the registry defaults to the caller's account).
 */
export interface ListImagesRequest extends Omit<
  ecr.ListImagesRequest,
  "registryId" | "repositoryName"
> {}

/**
 * Runtime binding for `ecr:ListImages`.
 *
 * Lists the image IDs (digest + tag) in the bound repository. Provide the implementation with
 * `Effect.provide(AWS.ECR.ListImagesHttp)`.
 * @binding
 * @section Reading Images
 * @example List Tagged Image IDs
 * ```typescript
 * const listImages = yield* AWS.ECR.ListImages(repository);
 *
 * const res = yield* listImages({ filter: { tagStatus: "TAGGED" } });
 * for (const id of res.imageIds ?? []) console.log(id.imageTag);
 * ```
 */
export interface ListImages extends Binding.Service<
  ListImages,
  "AWS.ECR.ListImages",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request?: ListImagesRequest,
    ) => Effect.Effect<ecr.ListImagesResponse, ecr.ListImagesError>
  >
> {}

export const ListImages = Binding.Service<ListImages>("AWS.ECR.ListImages");
