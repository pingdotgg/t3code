import type * as incidents from "@distilled.cloud/aws/ssm-incidents";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-incidents:UpdateRelatedItems`.
 *
 * Attaches or removes a related item on an incident — link the dashboard,
 * ticket, or runbook execution your automation is working from. Related items
 * live under runtime incident-record ARNs, so the deploy-time grant is
 * account-level (`Resource: "*"`).
 * Provide the implementation with
 * `Effect.provide(AWS.SSMIncidents.UpdateRelatedItemsHttp)`.
 * @binding
 * @section Related Items
 * @example Attach A Link To An Incident
 * ```typescript
 * // init
 * const updateRelatedItems = yield* AWS.SSMIncidents.UpdateRelatedItems();
 *
 * // runtime
 * yield* updateRelatedItems({
 *   incidentRecordArn,
 *   relatedItemsUpdate: {
 *     itemToAdd: {
 *       title: "Grafana dashboard",
 *       identifier: { type: "OTHER", value: { url: "https://grafana.example.com/d/abc" } },
 *     },
 *   },
 * });
 * ```
 */
export interface UpdateRelatedItems extends Binding.Service<
  UpdateRelatedItems,
  "AWS.SSMIncidents.UpdateRelatedItems",
  () => Effect.Effect<
    (
      request: incidents.UpdateRelatedItemsInput,
    ) => Effect.Effect<
      incidents.UpdateRelatedItemsOutput,
      incidents.UpdateRelatedItemsError
    >
  >
> {}
export const UpdateRelatedItems = Binding.Service<UpdateRelatedItems>(
  "AWS.SSMIncidents.UpdateRelatedItems",
);
