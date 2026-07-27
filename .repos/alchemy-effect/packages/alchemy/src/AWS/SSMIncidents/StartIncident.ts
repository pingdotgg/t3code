import type * as incidents from "@distilled.cloud/aws/ssm-incidents";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ResponsePlan } from "./ResponsePlan.ts";

/**
 * Runtime binding for `ssm-incidents:StartIncident`.
 *
 * Starts an incident from the bound {@link ResponsePlan} — Incident Manager
 * creates the incident record, engages the plan's contacts, posts to its
 * chat channel, and runs its Automation runbooks. The response plan ARN is
 * injected from the binding; pass `triggerDetails` to record what fired the
 * incident.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMIncidents.StartIncidentHttp)`.
 * @binding
 * @section Starting Incidents
 * @example Open An Incident From An Alarm Handler
 * ```typescript
 * // init — bind the operation to the response plan
 * const startIncident = yield* AWS.SSMIncidents.StartIncident(plan);
 *
 * // runtime
 * const { incidentRecordArn } = yield* startIncident({
 *   title: "checkout p99 breach",
 *   impact: 2,
 *   triggerDetails: {
 *     source: "custom.checkout-monitor",
 *     timestamp: new Date(),
 *   },
 * });
 * ```
 */
export interface StartIncident extends Binding.Service<
  StartIncident,
  "AWS.SSMIncidents.StartIncident",
  (
    plan: ResponsePlan,
  ) => Effect.Effect<
    (
      request?: Omit<incidents.StartIncidentInput, "responsePlanArn">,
    ) => Effect.Effect<
      incidents.StartIncidentOutput,
      incidents.StartIncidentError
    >
  >
> {}
export const StartIncident = Binding.Service<StartIncident>(
  "AWS.SSMIncidents.StartIncident",
);
