import type * as incidents from "@distilled.cloud/aws/ssm-incidents";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-incidents:ListIncidentRecords`.
 *
 * Lists the incident records in the account — the incidents started from any
 * response plan. Incident records are runtime entities (their ARNs embed the
 * response-plan name and a UUID that only exist once an incident starts), so
 * the deploy-time grant is account-level (`Resource: "*"`).
 * Provide the implementation with
 * `Effect.provide(AWS.SSMIncidents.ListIncidentRecordsHttp)`.
 * @binding
 * @section Reading Incident Records
 * @example List Open Incidents
 * ```typescript
 * // init
 * const listIncidentRecords = yield* AWS.SSMIncidents.ListIncidentRecords();
 *
 * // runtime
 * const { incidentRecordSummaries } = yield* listIncidentRecords({
 *   filters: [{ key: "status", condition: { equals: { stringValues: ["OPEN"] } } }],
 * });
 * ```
 */
export interface ListIncidentRecords extends Binding.Service<
  ListIncidentRecords,
  "AWS.SSMIncidents.ListIncidentRecords",
  () => Effect.Effect<
    (
      request: incidents.ListIncidentRecordsInput,
    ) => Effect.Effect<
      incidents.ListIncidentRecordsOutput,
      incidents.ListIncidentRecordsError
    >
  >
> {}
export const ListIncidentRecords = Binding.Service<ListIncidentRecords>(
  "AWS.SSMIncidents.ListIncidentRecords",
);
