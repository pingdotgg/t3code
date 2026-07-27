import type * as appintegrations from "@distilled.cloud/aws/appintegrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EventIntegration } from "./EventIntegration.ts";

export interface ListEventIntegrationAssociationsRequest extends Omit<
  appintegrations.ListEventIntegrationAssociationsRequest,
  "EventIntegrationName"
> {}

/**
 * Lists the associations of an AppIntegrations {@link EventIntegration} —
 * the clients that have associated with the event integration
 * (`app-integrations:ListEventIntegrationAssociations`).
 *
 * Provide the `ListEventIntegrationAssociationsHttp` layer on the Function
 * to satisfy the binding.
 * @binding
 * @section Listing Event Integration Associations
 * @example List an Event Integration's Associations
 * ```typescript
 * // init (provide AWS.AppIntegrations.ListEventIntegrationAssociationsHttp on the Function)
 * const listEventIntegrationAssociations =
 *   yield* AWS.AppIntegrations.ListEventIntegrationAssociations(integration);
 *
 * // runtime — the EventIntegrationName is injected automatically
 * const { EventIntegrationAssociations } =
 *   yield* listEventIntegrationAssociations();
 * ```
 */
export interface ListEventIntegrationAssociations extends Binding.Service<
  ListEventIntegrationAssociations,
  "AWS.AppIntegrations.ListEventIntegrationAssociations",
  <R extends EventIntegration>(
    integration: R,
  ) => Effect.Effect<
    (
      request?: ListEventIntegrationAssociationsRequest,
    ) => Effect.Effect<
      appintegrations.ListEventIntegrationAssociationsResponse,
      appintegrations.ListEventIntegrationAssociationsError
    >
  >
> {}
export const ListEventIntegrationAssociations =
  Binding.Service<ListEventIntegrationAssociations>(
    "AWS.AppIntegrations.ListEventIntegrationAssociations",
  );
