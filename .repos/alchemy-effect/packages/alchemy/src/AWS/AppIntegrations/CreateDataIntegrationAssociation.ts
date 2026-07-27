import type * as appintegrations from "@distilled.cloud/aws/appintegrations";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataIntegration } from "./DataIntegration.ts";

export interface CreateDataIntegrationAssociationRequest extends Omit<
  appintegrations.CreateDataIntegrationAssociationRequest,
  "DataIntegrationIdentifier"
> {}

/**
 * Associates a client (identified by `ClientId` / `ClientAssociationMetadata`)
 * with an AppIntegrations {@link DataIntegration}
 * (`app-integrations:CreateDataIntegrationAssociation`). Associations have no
 * independent delete API — they live and die with the data integration — so
 * they are exposed as a runtime binding rather than a Resource.
 *
 * Provide the `CreateDataIntegrationAssociationHttp` layer on the Function to
 * satisfy the binding.
 * @binding
 * @section Creating Data Integration Associations
 * @example Associate a Client with a Data Integration
 * ```typescript
 * // init (provide AWS.AppIntegrations.CreateDataIntegrationAssociationHttp on the Function)
 * const createDataIntegrationAssociation =
 *   yield* AWS.AppIntegrations.CreateDataIntegrationAssociation(integration);
 *
 * // runtime — the DataIntegrationIdentifier is injected automatically
 * const { DataIntegrationAssociationId } =
 *   yield* createDataIntegrationAssociation({
 *     ClientId: "my-client",
 *     ClientAssociationMetadata: { purpose: "sync" },
 *   });
 * ```
 */
export interface CreateDataIntegrationAssociation extends Binding.Service<
  CreateDataIntegrationAssociation,
  "AWS.AppIntegrations.CreateDataIntegrationAssociation",
  <R extends DataIntegration>(
    integration: R,
  ) => Effect.Effect<
    (
      request?: CreateDataIntegrationAssociationRequest,
    ) => Effect.Effect<
      appintegrations.CreateDataIntegrationAssociationResponse,
      appintegrations.CreateDataIntegrationAssociationError
    >
  >
> {}
export const CreateDataIntegrationAssociation =
  Binding.Service<CreateDataIntegrationAssociation>(
    "AWS.AppIntegrations.CreateDataIntegrationAssociation",
  );
