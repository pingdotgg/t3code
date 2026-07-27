import type * as personalize from "@distilled.cloud/aws/personalize";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `personalize:CreateSolutionVersion` — Trains a new model (solution version) for an existing solution — the
 * retraining step of the MLOps loop, typically run on a schedule after
 * fresh data is imported.
 * Provide the implementation with
 * `Effect.provide(AWS.Personalize.CreateSolutionVersionHttp)`.
 *
 * @binding
 * @section Retraining Loop
 * @example Retrain a Solution
 * ```typescript
 * // init
 * const createSolutionVersion = yield* Personalize.CreateSolutionVersion();
 *
 * const { solutionVersionArn } = yield* createSolutionVersion({
 *   solutionArn,
 *   trainingMode: "UPDATE",
 * });
 * ```
 */
export interface CreateSolutionVersion extends Binding.Service<
  CreateSolutionVersion,
  "AWS.Personalize.CreateSolutionVersion",
  () => Effect.Effect<
    (
      request: personalize.CreateSolutionVersionRequest,
    ) => Effect.Effect<
      personalize.CreateSolutionVersionResponse,
      personalize.CreateSolutionVersionError
    >
  >
> {}
export const CreateSolutionVersion = Binding.Service<CreateSolutionVersion>(
  "AWS.Personalize.CreateSolutionVersion",
);
