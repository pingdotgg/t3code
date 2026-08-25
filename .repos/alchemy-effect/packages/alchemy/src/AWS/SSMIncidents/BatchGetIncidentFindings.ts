import type * as incidents from "@distilled.cloud/aws/ssm-incidents";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-incidents:BatchGetIncidentFindings`.
 *
 * Returns the details of the findings correlated with an incident — the
 * CodeDeploy deployment or CloudFormation stack update suspected of causing
 * it. Findings live under runtime incident-record ARNs, so the deploy-time
 * grant is account-level (`Resource: "*"`).
 * Provide the implementation with
 * `Effect.provide(AWS.SSMIncidents.BatchGetIncidentFindingsHttp)`.
 * @binding
 * @section Findings
 * @example Read Finding Details
 * ```typescript
 * // init
 * const batchGetIncidentFindings = yield* AWS.SSMIncidents.BatchGetIncidentFindings();
 *
 * // runtime
 * const { findings } = yield* batchGetIncidentFindings({
 *   incidentRecordArn,
 *   findingIds,
 * });
 * ```
 */
export interface BatchGetIncidentFindings extends Binding.Service<
  BatchGetIncidentFindings,
  "AWS.SSMIncidents.BatchGetIncidentFindings",
  () => Effect.Effect<
    (
      request: incidents.BatchGetIncidentFindingsInput,
    ) => Effect.Effect<
      incidents.BatchGetIncidentFindingsOutput,
      incidents.BatchGetIncidentFindingsError
    >
  >
> {}
export const BatchGetIncidentFindings =
  Binding.Service<BatchGetIncidentFindings>(
    "AWS.SSMIncidents.BatchGetIncidentFindings",
  );
