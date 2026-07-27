import type * as incidents from "@distilled.cloud/aws/ssm-incidents";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-incidents:GetIncidentRecord`.
 *
 * Returns the details of an incident record — title, impact, status, chat
 * channel, and notification targets. Incident-record ARNs only exist at
 * runtime, so the deploy-time grant is account-level (`Resource: "*"`).
 * Provide the implementation with
 * `Effect.provide(AWS.SSMIncidents.GetIncidentRecordHttp)`.
 * @binding
 * @section Reading Incident Records
 * @example Read An Incident
 * ```typescript
 * // init
 * const getIncidentRecord = yield* AWS.SSMIncidents.GetIncidentRecord();
 *
 * // runtime
 * const { incidentRecord } = yield* getIncidentRecord({ arn: incidentRecordArn });
 * ```
 */
export interface GetIncidentRecord extends Binding.Service<
  GetIncidentRecord,
  "AWS.SSMIncidents.GetIncidentRecord",
  () => Effect.Effect<
    (
      request: incidents.GetIncidentRecordInput,
    ) => Effect.Effect<
      incidents.GetIncidentRecordOutput,
      incidents.GetIncidentRecordError
    >
  >
> {}
export const GetIncidentRecord = Binding.Service<GetIncidentRecord>(
  "AWS.SSMIncidents.GetIncidentRecord",
);
