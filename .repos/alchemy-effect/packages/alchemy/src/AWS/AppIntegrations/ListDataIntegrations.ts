import type * as appintegrations from "@distilled.cloud/aws/appintegrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListDataIntegrationsRequest
  extends appintegrations.ListDataIntegrationsRequest {}

/**
 * Lists the AppIntegrations data integrations in the account
 * (`app-integrations:ListDataIntegrations`).
 *
 * An account-level operation — bind it with no resource argument. Provide the
 * `ListDataIntegrationsHttp` layer on the Function to satisfy the binding.
 * @binding
 * @section Listing Data Integrations
 * @example List All Data Integrations
 * ```typescript
 * // init — no resource argument (provide AWS.AppIntegrations.ListDataIntegrationsHttp on the Function)
 * const listDataIntegrations = yield* AWS.AppIntegrations.ListDataIntegrations();
 *
 * // runtime — page through the data integrations in the account
 * const { DataIntegrations } = yield* listDataIntegrations({});
 * ```
 */
export interface ListDataIntegrations extends Binding.Service<
  ListDataIntegrations,
  "AWS.AppIntegrations.ListDataIntegrations",
  () => Effect.Effect<
    (
      request?: ListDataIntegrationsRequest,
    ) => Effect.Effect<
      appintegrations.ListDataIntegrationsResponse,
      appintegrations.ListDataIntegrationsError
    >
  >
> {}
export const ListDataIntegrations = Binding.Service<ListDataIntegrations>(
  "AWS.AppIntegrations.ListDataIntegrations",
);
