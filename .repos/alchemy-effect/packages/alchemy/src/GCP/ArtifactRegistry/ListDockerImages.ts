import type * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Repository } from "./Repository.ts";

export interface ListDockerImagesRequest extends Omit<
  artifactregistry.ListProjectsLocationsRepositoriesDockerImagesRequest,
  "parent"
> {}

/**
 * Runtime binding for Artifact Registry `dockerImages.list`.
 *
 * Bind this operation to a {@link Repository} in a Function/Action init
 * phase. Provide {@link ListDockerImagesHttp}.
 *
 * ### Listing Docker Images
 * **Example:** List images in a repository
 * ```typescript
 * const listImages = yield* GCP.ArtifactRegistry.ListDockerImages(images);
 * const page = yield* listImages({ pageSize: 50 });
 * ```
 *
 * @binding
 * @category ArtifactRegistry
 */
export interface ListDockerImages extends Binding.Service<
  ListDockerImages,
  "GCP.ArtifactRegistry.ListDockerImages",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request?: ListDockerImagesRequest,
    ) => Effect.Effect<
      artifactregistry.ListDockerImagesResponse,
      artifactregistry.ListProjectsLocationsRepositoriesDockerImagesError,
      RuntimeContext
    >
  >
> {}

export const ListDockerImages = Binding.Service<ListDockerImages>(
  "GCP.ArtifactRegistry.ListDockerImages",
);
