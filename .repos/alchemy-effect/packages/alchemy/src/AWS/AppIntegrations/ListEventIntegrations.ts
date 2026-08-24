import type * as appintegrations from "@distilled.cloud/aws/appintegrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListEventIntegrationsRequest
  extends appintegrations.ListEventIntegrationsRequest {}

/**
 * Lists the AppIntegrations event integrations in the account
 * (`app-integrations:ListEventIntegrations`).
 *
 * An account-level operation — bind it with no resource argument. Provide the
 * `ListEventIntegrationsHttp` layer on the Function to satisfy the binding.
 * @binding
 * @section Listing Event Integrations
 * @example List All Event Integrations
 * ```typescript
 * // init — no resource argument (provide AWS.AppIntegrations.ListEventIntegrationsHttp on the Function)
 * const listEventIntegrations = yield* AWS.AppIntegrations.ListEventIntegrations();
 *
 * // runtime — page through the event integrations in the account
 * const { EventIntegrations } = yield* listEventIntegrations({});
 * ```
 */
export interface ListEventIntegrations extends Binding.Service<
  ListEventIntegrations,
  "AWS.AppIntegrations.ListEventIntegrations",
  () => Effect.Effect<
    (
      request?: ListEventIntegrationsRequest,
    ) => Effect.Effect<
      appintegrations.ListEventIntegrationsResponse,
      appintegrations.ListEventIntegrationsError
    >
  >
> {}
export const ListEventIntegrations = Binding.Service<ListEventIntegrations>(
  "AWS.AppIntegrations.ListEventIntegrations",
);
