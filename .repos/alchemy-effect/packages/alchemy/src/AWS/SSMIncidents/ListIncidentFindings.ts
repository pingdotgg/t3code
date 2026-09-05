import type * as incidents from "@distilled.cloud/aws/ssm-incidents";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-incidents:ListIncidentFindings`.
 *
 * Lists the findings (CodeDeploy deployments and CloudFormation stack updates
 * around the incident's start time) that Incident Manager correlated with an
 * incident. Findings live under runtime incident-record ARNs, so the
 * deploy-time grant is account-level (`Resource: "*"`).
 * Provide the implementation with
 * `Effect.provide(AWS.SSMIncidents.ListIncidentFindingsHttp)`.
 * @binding
 * @section Findings
 * @example List An Incident's Findings
 * ```typescript
 * // init
 * const listIncidentFindings = yield* AWS.SSMIncidents.ListIncidentFindings();
 *
 * // runtime
 * const { findings } = yield* listIncidentFindings({ incidentRecordArn });
 * ```
 */
export interface ListIncidentFindings extends Binding.Service<
  ListIncidentFindings,
  "AWS.SSMIncidents.ListIncidentFindings",
  () => Effect.Effect<
    (
      request: incidents.ListIncidentFindingsInput,
    ) => Effect.Effect<
      incidents.ListIncidentFindingsOutput,
      incidents.ListIncidentFindingsError
    >
  >
> {}
export const ListIncidentFindings = Binding.Service<ListIncidentFindings>(
  "AWS.SSMIncidents.ListIncidentFindings",
);
