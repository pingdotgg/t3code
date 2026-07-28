import type * as incidents from "@distilled.cloud/aws/ssm-incidents";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ssm-incidents:ListRelatedItems`.
 *
 * Lists the related items of an incident — attached metrics, runbook
 * executions, parent tickets, and links. Related items live under runtime
 * incident-record ARNs, so the deploy-time grant is account-level
 * (`Resource: "*"`).
 * Provide the implementation with
 * `Effect.provide(AWS.SSMIncidents.ListRelatedItemsHttp)`.
 * @binding
 * @section Related Items
 * @example List An Incident's Related Items
 * ```typescript
 * // init
 * const listRelatedItems = yield* AWS.SSMIncidents.ListRelatedItems();
 *
 * // runtime
 * const { relatedItems } = yield* listRelatedItems({ incidentRecordArn });
 * ```
 */
export interface ListRelatedItems extends Binding.Service<
  ListRelatedItems,
  "AWS.SSMIncidents.ListRelatedItems",
  () => Effect.Effect<
    (
      request: incidents.ListRelatedItemsInput,
    ) => Effect.Effect<
      incidents.ListRelatedItemsOutput,
      incidents.ListRelatedItemsError
    >
  >
> {}
export const ListRelatedItems = Binding.Service<ListRelatedItems>(
  "AWS.SSMIncidents.ListRelatedItems",
);
