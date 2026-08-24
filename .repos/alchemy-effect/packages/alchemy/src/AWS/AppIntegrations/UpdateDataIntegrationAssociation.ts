import type * as appintegrations from "@distilled.cloud/aws/appintegrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataIntegration } from "./DataIntegration.ts";

export interface UpdateDataIntegrationAssociationRequest extends Omit<
  appintegrations.UpdateDataIntegrationAssociationRequest,
  "DataIntegrationIdentifier"
> {}

/**
 * Updates an association of an AppIntegrations {@link DataIntegration}
 * (`app-integrations:UpdateDataIntegrationAssociation`). Updating an
 * association with an `ON_DEMAND` `ExecutionConfiguration` reruns the
 * on-demand data-pull job — this is the data-plane trigger for pulling
 * source data again.
 *
 * Provide the `UpdateDataIntegrationAssociationHttp` layer on the Function to
 * satisfy the binding.
 * @binding
 * @section Updating Data Integration Associations
 * @example Rerun an On-Demand Data Pull
 * ```typescript
 * // init (provide AWS.AppIntegrations.UpdateDataIntegrationAssociationHttp on the Function)
 * const updateDataIntegrationAssociation =
 *   yield* AWS.AppIntegrations.UpdateDataIntegrationAssociation(integration);
 *
 * // runtime — the DataIntegrationIdentifier is injected automatically
 * yield* updateDataIntegrationAssociation({
 *   DataIntegrationAssociationIdentifier: associationId,
 *   ExecutionConfiguration: {
 *     ExecutionMode: "ON_DEMAND",
 *     OnDemandConfiguration: { StartTime: startEpochMillis },
 *   },
 * });
 * ```
 */
export interface UpdateDataIntegrationAssociation extends Binding.Service<
  UpdateDataIntegrationAssociation,
  "AWS.AppIntegrations.UpdateDataIntegrationAssociation",
  <R extends DataIntegration>(
    integration: R,
  ) => Effect.Effect<
    (
      request: UpdateDataIntegrationAssociationRequest,
    ) => Effect.Effect<
      appintegrations.UpdateDataIntegrationAssociationResponse,
      appintegrations.UpdateDataIntegrationAssociationError
    >
  >
> {}
export const UpdateDataIntegrationAssociation =
  Binding.Service<UpdateDataIntegrationAssociation>(
    "AWS.AppIntegrations.UpdateDataIntegrationAssociation",
  );
