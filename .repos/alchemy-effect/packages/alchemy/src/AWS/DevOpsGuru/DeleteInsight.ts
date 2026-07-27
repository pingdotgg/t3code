import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:DeleteInsight`.
 *
 * Deletes a closed insight — housekeeping automation for insights that have been triaged and resolved. Only closed insights can be deleted.
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.DeleteInsightHttp)`.
 * @binding
 * @section Inspecting Insights
 * @example Delete a Closed Insight
 * ```typescript
 * // init — account-level binding, no resource argument
 * const deleteInsight = yield* AWS.DevOpsGuru.DeleteInsight();
 *
 * // runtime
 * yield* deleteInsight({ Id: insightId });
 * ```
 */
export interface DeleteInsight extends Binding.Service<
  DeleteInsight,
  "AWS.DevOpsGuru.DeleteInsight",
  () => Effect.Effect<
    (
      request: devopsguru.DeleteInsightRequest,
    ) => Effect.Effect<
      devopsguru.DeleteInsightResponse,
      devopsguru.DeleteInsightError
    >
  >
> {}
export const DeleteInsight = Binding.Service<DeleteInsight>(
  "AWS.DevOpsGuru.DeleteInsight",
);
