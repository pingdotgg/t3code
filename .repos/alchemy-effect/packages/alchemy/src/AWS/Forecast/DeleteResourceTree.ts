import type * as forecast from "@distilled.cloud/aws/forecast";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `forecast:DeleteResourceTree` — delete an entire tree
 * of runtime-created Forecast resources (a predictor and its forecasts and
 * exports, or a dataset's import jobs) in a single call, the cost-hygiene
 * counterpart to the `Create*` bindings.
 *
 * The target ARNs are created at runtime, so the binding takes no arguments
 * and grants `forecast:DeleteResourceTree` on `*`. Provide the implementation
 * with `Effect.provide(AWS.Forecast.DeleteResourceTreeHttp)`.
 *
 * @binding
 * @section Cleaning Up
 * @example Delete a Predictor's Artifact Tree
 * ```typescript
 * // init
 * const deleteResourceTree = yield* AWS.Forecast.DeleteResourceTree();
 *
 * // runtime
 * yield* deleteResourceTree({ ResourceArn: predictorArn });
 * ```
 */
export interface DeleteResourceTree extends Binding.Service<
  DeleteResourceTree,
  "AWS.Forecast.DeleteResourceTree",
  () => Effect.Effect<
    (
      request: forecast.DeleteResourceTreeRequest,
    ) => Effect.Effect<
      forecast.DeleteResourceTreeResponse,
      forecast.DeleteResourceTreeError
    >
  >
> {}
export const DeleteResourceTree = Binding.Service<DeleteResourceTree>(
  "AWS.Forecast.DeleteResourceTree",
);
