import type * as ecrpublic from "@distilled.cloud/aws/ecr-public";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PublicRepository } from "./Repository.ts";

/**
 * Request for {@link BatchCheckLayerAvailability} — `repositoryName` is
 * injected.
 */
export interface BatchCheckLayerAvailabilityRequest extends Omit<
  ecrpublic.BatchCheckLayerAvailabilityRequest,
  "repositoryName"
> {}

/**
 * Runtime binding for `ecr-public:BatchCheckLayerAvailability`.
 *
 * Checks whether image layers already exist in the bound
 * {@link PublicRepository} so a push can skip re-uploading them. Provide
 * the implementation with
 * `Effect.provide(AWS.ECRPublic.BatchCheckLayerAvailabilityHttp)`.
 *
 * @binding
 * @section Pushing Images
 * @example Check Layer Availability Before Uploading
 * ```typescript
 * // init
 * const checkLayers = yield* AWS.ECRPublic.BatchCheckLayerAvailability(repository);
 *
 * // runtime
 * const result = yield* checkLayers({ layerDigests: ["sha256:abc..."] });
 * const missing = (result.failures ?? []).map((f) => f.layerDigest);
 * ```
 */
export interface BatchCheckLayerAvailability extends Binding.Service<
  BatchCheckLayerAvailability,
  "AWS.ECRPublic.BatchCheckLayerAvailability",
  <R extends PublicRepository>(
    repository: R,
  ) => Effect.Effect<
    (
      request: BatchCheckLayerAvailabilityRequest,
    ) => Effect.Effect<
      ecrpublic.BatchCheckLayerAvailabilityResponse,
      ecrpublic.BatchCheckLayerAvailabilityError
    >
  >
> {}

export const BatchCheckLayerAvailability =
  Binding.Service<BatchCheckLayerAvailability>(
    "AWS.ECRPublic.BatchCheckLayerAvailability",
  );
