import type * as appintegrations from "@distilled.cloud/aws/appintegrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataIntegration } from "./DataIntegration.ts";

export interface ListDataIntegrationAssociationsRequest extends Omit<
  appintegrations.ListDataIntegrationAssociationsRequest,
  "DataIntegrationIdentifier"
> {}

/**
 * Lists the associations of an AppIntegrations {@link DataIntegration} — the
 * clients (e.g. Amazon Connect / Amazon Q) it has been associated with
 * (`app-integrations:ListDataIntegrationAssociations`).
 *
 * Provide the `ListDataIntegrationAssociationsHttp` layer on the Function to
 * satisfy the binding.
 * @binding
 * @section Listing Data Integration Associations
 * @example List a Data Integration's Associations
 * ```typescript
 * // init (provide AWS.AppIntegrations.ListDataIntegrationAssociationsHttp on the Function)
 * const listDataIntegrationAssociations =
 *   yield* AWS.AppIntegrations.ListDataIntegrationAssociations(integration);
 *
 * // runtime — the DataIntegrationIdentifier is injected automatically
 * const { DataIntegrationAssociations } =
 *   yield* listDataIntegrationAssociations();
 * ```
 */
export interface ListDataIntegrationAssociations extends Binding.Service<
  ListDataIntegrationAssociations,
  "AWS.AppIntegrations.ListDataIntegrationAssociations",
  <R extends DataIntegration>(
    integration: R,
  ) => Effect.Effect<
    (
      request?: ListDataIntegrationAssociationsRequest,
    ) => Effect.Effect<
      appintegrations.ListDataIntegrationAssociationsResponse,
      appintegrations.ListDataIntegrationAssociationsError
    >
  >
> {}
export const ListDataIntegrationAssociations =
  Binding.Service<ListDataIntegrationAssociations>(
    "AWS.AppIntegrations.ListDataIntegrationAssociations",
  );
