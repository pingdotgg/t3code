import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `devops-guru:ListAnomaliesForInsight`.
 *
 * Lists the anomalies that belong to an insight — the individual metric deviations DevOps Guru correlated into the incident.
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.ListAnomaliesForInsightHttp)`.
 * ### Inspecting Anomalies
 * **Example:** List an Insight's Anomalies
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listAnomaliesForInsight = yield* AWS.DevOpsGuru.ListAnomaliesForInsight();
 *
 * // runtime
 * const { ReactiveAnomalies } = yield* listAnomaliesForInsight({
 *   InsightId: insightId,
 * });
 * yield* Effect.log(`anomalies: ${ReactiveAnomalies?.length}`);
 * ```
 *
 * @binding
 */
export interface ListAnomaliesForInsight extends Binding.Service<
  ListAnomaliesForInsight,
  "AWS.DevOpsGuru.ListAnomaliesForInsight",
  () => Effect.Effect<
    (
      request: devopsguru.ListAnomaliesForInsightRequest,
    ) => Effect.Effect<
      devopsguru.ListAnomaliesForInsightResponse,
      devopsguru.ListAnomaliesForInsightError
    >
  >
> {}
export const ListAnomaliesForInsight = Binding.Service<ListAnomaliesForInsight>(
  "AWS.DevOpsGuru.ListAnomaliesForInsight",
);
