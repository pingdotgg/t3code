import type * as config from "@distilled.cloud/aws/config-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `config:GetResourceEvaluationSummary` — read the
 * status and compliance verdict of a proactive resource evaluation started
 * with `StartResourceEvaluation`.
 *
 * Provide `Config.GetResourceEvaluationSummaryHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Proactive Resource Evaluation
 * @example Read an Evaluation's Summary
 * ```typescript
 * // init — grants config:GetResourceEvaluationSummary
 * const getResourceEvaluationSummary = yield* AWS.Config.GetResourceEvaluationSummary();
 *
 * // runtime
 * const result = yield* getResourceEvaluationSummary({
 *   ResourceEvaluationId: evaluationId,
 * });
 * console.log(result.EvaluationStatus?.Status, result.Compliance);
 * ```
 */
export interface GetResourceEvaluationSummary extends Binding.Service<
  GetResourceEvaluationSummary,
  "AWS.Config.GetResourceEvaluationSummary",
  () => Effect.Effect<
    (
      request: config.GetResourceEvaluationSummaryRequest,
    ) => Effect.Effect<
      config.GetResourceEvaluationSummaryResponse,
      config.GetResourceEvaluationSummaryError
    >
  >
> {}

export const GetResourceEvaluationSummary =
  Binding.Service<GetResourceEvaluationSummary>(
    "AWS.Config.GetResourceEvaluationSummary",
  );
