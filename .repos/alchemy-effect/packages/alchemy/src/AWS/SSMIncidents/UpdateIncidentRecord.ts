import type * as incidents from "@distilled.cloud/aws/ssm-incidents";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-incidents:UpdateIncidentRecord`.
 *
 * Updates the details of an incident record — retitle, change impact, or
 * resolve the incident by setting `status: "RESOLVED"`. Incident-record ARNs
 * only exist at runtime, so the deploy-time grant is account-level
 * (`Resource: "*"`).
 * Provide the implementation with
 * `Effect.provide(AWS.SSMIncidents.UpdateIncidentRecordHttp)`.
 * @binding
 * @section Updating Incident Records
 * @example Resolve An Incident
 * ```typescript
 * // init
 * const updateIncidentRecord = yield* AWS.SSMIncidents.UpdateIncidentRecord();
 *
 * // runtime
 * yield* updateIncidentRecord({ arn: incidentRecordArn, status: "RESOLVED" });
 * ```
 */
export interface UpdateIncidentRecord extends Binding.Service<
  UpdateIncidentRecord,
  "AWS.SSMIncidents.UpdateIncidentRecord",
  () => Effect.Effect<
    (
      request: incidents.UpdateIncidentRecordInput,
    ) => Effect.Effect<
      incidents.UpdateIncidentRecordOutput,
      incidents.UpdateIncidentRecordError
    >
  >
> {}
export const UpdateIncidentRecord = Binding.Service<UpdateIncidentRecord>(
  "AWS.SSMIncidents.UpdateIncidentRecord",
);
