import type * as incidents from "@distilled.cloud/aws/ssm-incidents";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-incidents:DeleteIncidentRecord`.
 *
 * Deletes an incident record (idempotent — deleting a record that does not
 * exist succeeds). Incident-record ARNs only exist at runtime, so the
 * deploy-time grant is account-level (`Resource: "*"`).
 * Provide the implementation with
 * `Effect.provide(AWS.SSMIncidents.DeleteIncidentRecordHttp)`.
 * @binding
 * @section Updating Incident Records
 * @example Delete An Incident Record
 * ```typescript
 * // init
 * const deleteIncidentRecord = yield* AWS.SSMIncidents.DeleteIncidentRecord();
 *
 * // runtime
 * yield* deleteIncidentRecord({ arn: incidentRecordArn });
 * ```
 */
export interface DeleteIncidentRecord extends Binding.Service<
  DeleteIncidentRecord,
  "AWS.SSMIncidents.DeleteIncidentRecord",
  () => Effect.Effect<
    (
      request: incidents.DeleteIncidentRecordInput,
    ) => Effect.Effect<
      incidents.DeleteIncidentRecordOutput,
      incidents.DeleteIncidentRecordError
    >
  >
> {}
export const DeleteIncidentRecord = Binding.Service<DeleteIncidentRecord>(
  "AWS.SSMIncidents.DeleteIncidentRecord",
);
