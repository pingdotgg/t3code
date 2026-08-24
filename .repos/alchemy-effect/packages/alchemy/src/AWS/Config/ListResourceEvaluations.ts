import type * as config from "@distilled.cloud/aws/config-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `config:ListResourceEvaluations` — enumerate the
 * proactive resource evaluations run in the account, optionally filtered
 * by evaluation mode and time window.
 *
 * Provide `Config.ListResourceEvaluationsHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Proactive Resource Evaluation
 * @example List Proactive Evaluations
 * ```typescript
 * // init — grants config:ListResourceEvaluations
 * const listResourceEvaluations = yield* AWS.Config.ListResourceEvaluations();
 *
 * // runtime
 * const result = yield* listResourceEvaluations({
 *   Filters: { EvaluationMode: "PROACTIVE" },
 * });
 * console.log(result.ResourceEvaluations);
 * ```
 */
export interface ListResourceEvaluations extends Binding.Service<
  ListResourceEvaluations,
  "AWS.Config.ListResourceEvaluations",
  () => Effect.Effect<
    (
      request?: config.ListResourceEvaluationsRequest,
    ) => Effect.Effect<
      config.ListResourceEvaluationsResponse,
      config.ListResourceEvaluationsError
    >
  >
> {}

export const ListResourceEvaluations = Binding.Service<ListResourceEvaluations>(
  "AWS.Config.ListResourceEvaluations",
);
