import type * as personalize from "@distilled.cloud/aws/personalize";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `personalize:CreateSolution` — Creates a solution (a recipe + configuration to train models with)
 * for a dataset group — set `performAutoTraining` to keep models fresh
 * automatically.
 * Provide the implementation with
 * `Effect.provide(AWS.Personalize.CreateSolutionHttp)`.
 *
 * @binding
 * @section Retraining Loop
 * @example Create a Solution
 * ```typescript
 * // init
 * const createSolution = yield* Personalize.CreateSolution();
 *
 * const { solutionArn } = yield* createSolution({
 *   name: "user-personalization",
 *   recipeArn: "arn:aws:personalize:::recipe/aws-user-personalization",
 *   datasetGroupArn,
 * });
 * ```
 */
export interface CreateSolution extends Binding.Service<
  CreateSolution,
  "AWS.Personalize.CreateSolution",
  () => Effect.Effect<
    (
      request: personalize.CreateSolutionRequest,
    ) => Effect.Effect<
      personalize.CreateSolutionResponse,
      personalize.CreateSolutionError
    >
  >
> {}
export const CreateSolution = Binding.Service<CreateSolution>(
  "AWS.Personalize.CreateSolution",
);
