import type * as opensearch from "@distilled.cloud/aws/opensearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListScheduledActions` operation (IAM action
 * `es:ListScheduledActions`).
 *
 * Lists the actions scheduled on a domain — service software updates, blue/green Auto-Tune changes — with their scheduled time and severity. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.ListScheduledActionsHttp)`.
 * @binding
 * @section Auto-Tune and Scheduled Actions
 * @example List a Domain's Scheduled Actions
 * ```typescript
 * const listScheduledActions = yield* OpenSearch.ListScheduledActions();
 *
 * const result = yield* listScheduledActions({ DomainName: name });
 * // result.ScheduledActions → pending actions
 * ```
 */
export interface ListScheduledActions extends Binding.Service<
  ListScheduledActions,
  "AWS.OpenSearch.ListScheduledActions",
  () => Effect.Effect<
    (
      request: opensearch.ListScheduledActionsRequest,
    ) => Effect.Effect<
      opensearch.ListScheduledActionsResponse,
      opensearch.ListScheduledActionsError
    >
  >
> {}
export const ListScheduledActions = Binding.Service<ListScheduledActions>(
  "AWS.OpenSearch.ListScheduledActions",
);
