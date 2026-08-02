import type * as ecr from "@distilled.cloud/aws/ecr";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link BatchCheckLayerAvailability} — `repositoryName` is injected from the
 * bound {@link Repository} (the registry defaults to the caller's account).
 */
export interface BatchCheckLayerAvailabilityRequest extends Omit<
  ecr.BatchCheckLayerAvailabilityRequest,
  "registryId" | "repositoryName"
> {}

/**
 * Runtime binding for `ecr:BatchCheckLayerAvailability`.
 *
 * Checks whether image layers already exist in the bound repository — pushed clients call this before uploading to skip blobs the registry already has. Provide the implementation with
 * `Effect.provide(AWS.ECR.BatchCheckLayerAvailabilityHttp)`.
 * @binding
 * @section Pushing Images
 * @example Skip Already-Pushed Layers
 * ```typescript
 * const checkLayers = yield* AWS.ECR.BatchCheckLayerAvailability(repository);
 *
 * const res = yield* checkLayers({ layerDigests: ["sha256:…"] });
 * const missing = res.layers?.filter((l) => l.layerAvailability === "UNAVAILABLE");
 * ```
 */
export interface BatchCheckLayerAvailability extends Binding.Service<
  BatchCheckLayerAvailability,
  "AWS.ECR.BatchCheckLayerAvailability",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: BatchCheckLayerAvailabilityRequest,
    ) => Effect.Effect<
      ecr.BatchCheckLayerAvailabilityResponse,
      ecr.BatchCheckLayerAvailabilityError
    >
  >
> {}

export const BatchCheckLayerAvailability =
  Binding.Service<BatchCheckLayerAvailability>(
    "AWS.ECR.BatchCheckLayerAvailability",
  );
