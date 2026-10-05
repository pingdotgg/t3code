import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ListDockerImages,
  type ListDockerImagesRequest,
} from "./ListDockerImages.ts";
import type { Repository } from "./Repository.ts";
import { bindGcpHost } from "../Host.ts";
import { grantFor } from "../HttpBinding.ts";

/**
 * HTTP implementation of {@link ListDockerImages}.
 *
 * @layer
 * @provides GCP.ArtifactRegistry.ListDockerImages
 */
export const ListDockerImagesHttp = Layer.effect(
  ListDockerImages,
  Effect.gen(function* () {
    const listDockerImages =
      yield* artifactregistry.listProjectsLocationsRepositoriesDockerImages;
    return Effect.fn(function* (repository: Repository) {
      yield* bindGcpHost({
        tag: "GCP.ArtifactRegistry.ListDockerImages",
        resource: repository,
        iam: [
          grantFor(
            {
              role: "roles/artifactregistry.reader",
              on: "artifactregistry.repository",
            },
            repository.name,
          ),
        ],
      });
      const name = yield* repository.name;
      return Effect.fn(
        `GCP.ArtifactRegistry.ListDockerImages(${repository.LogicalId})`,
      )(function* (request?: ListDockerImagesRequest) {
        return yield* listDockerImages({
          ...request,
          parent: yield* name,
        });
      });
    });
  }),
);
