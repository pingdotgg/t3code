import type * as personalize from "@distilled.cloud/aws/personalize";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `personalize:DescribeSolutionVersion` — Polls a solution version for training completion — pairs with
 * {@link CreateSolutionVersion} in the MLOps retraining loop.
 * Provide the implementation with
 * `Effect.provide(AWS.Personalize.DescribeSolutionVersionHttp)`.
 *
 * @binding
 * @section Retraining Loop
 * @example Poll a Training Run
 * ```typescript
 * // init
 * const describeSolutionVersion = yield* Personalize.DescribeSolutionVersion();
 *
 * const { solutionVersion } = yield* describeSolutionVersion({
 *   solutionVersionArn,
 * });
 * const trained = solutionVersion?.status === "ACTIVE";
 * ```
 */
export interface DescribeSolutionVersion extends Binding.Service<
  DescribeSolutionVersion,
  "AWS.Personalize.DescribeSolutionVersion",
  () => Effect.Effect<
    (
      request: personalize.DescribeSolutionVersionRequest,
    ) => Effect.Effect<
      personalize.DescribeSolutionVersionResponse,
      personalize.DescribeSolutionVersionError
    >
  >
> {}
export const DescribeSolutionVersion = Binding.Service<DescribeSolutionVersion>(
  "AWS.Personalize.DescribeSolutionVersion",
);
