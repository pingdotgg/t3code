import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:ListAnomalousLogGroups`.
 *
 * Lists the CloudWatch log groups that contain log anomalies for an insight (requires the service integration's log anomaly detection).
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.ListAnomalousLogGroupsHttp)`.
 * @binding
 * @section Inspecting Anomalies
 * @example List an Insight's Anomalous Log Groups
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listAnomalousLogGroups = yield* AWS.DevOpsGuru.ListAnomalousLogGroups();
 *
 * // runtime
 * const { AnomalousLogGroups } = yield* listAnomalousLogGroups({
 *   InsightId: insightId,
 * });
 * for (const group of AnomalousLogGroups ?? []) {
 *   yield* Effect.log(`${group.LogGroupName}: ${group.NumberOfLogLinesScanned} lines`);
 * }
 * ```
 */
export interface ListAnomalousLogGroups extends Binding.Service<
  ListAnomalousLogGroups,
  "AWS.DevOpsGuru.ListAnomalousLogGroups",
  () => Effect.Effect<
    (
      request: devopsguru.ListAnomalousLogGroupsRequest,
    ) => Effect.Effect<
      devopsguru.ListAnomalousLogGroupsResponse,
      devopsguru.ListAnomalousLogGroupsError
    >
  >
> {}
export const ListAnomalousLogGroups = Binding.Service<ListAnomalousLogGroups>(
  "AWS.DevOpsGuru.ListAnomalousLogGroups",
);
