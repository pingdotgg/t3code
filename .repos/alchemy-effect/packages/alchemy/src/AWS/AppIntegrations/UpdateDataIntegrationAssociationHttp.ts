import * as appintegrations from "@distilled.cloud/aws/appintegrations";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { makeAppIntegrationsHttpBinding } from "./BindingHttp.ts";
import type { DataIntegration } from "./DataIntegration.ts";
import { UpdateDataIntegrationAssociation } from "./UpdateDataIntegrationAssociation.ts";

/**
 * HTTP implementation of {@link UpdateDataIntegrationAssociation}. At deploy
 * time it grants `app-integrations:UpdateDataIntegrationAssociation` on the
 * data integration (and its `data-integration-association/*` children); at
 * runtime it calls the AppIntegrations API with the host Function's
 * credentials, injecting the data integration's id. Provide this layer on
 * the Function using the binding.
 */
export const UpdateDataIntegrationAssociationHttp = Layer.effect(
  UpdateDataIntegrationAssociation,
  makeAppIntegrationsHttpBinding({
    name: "UpdateDataIntegrationAssociation",
    operation: appintegrations.updateDataIntegrationAssociation,
    requestKey: "DataIntegrationIdentifier",
    identifier: (integration: DataIntegration) => integration.dataIntegrationId,
    iamActions: ["app-integrations:UpdateDataIntegrationAssociation"],
    resources: (integration, { region, accountId }) => [
      Output.interpolate`${integration.dataIntegrationArn}`,
      Output.interpolate`arn:aws:app-integrations:${region}:${accountId}:data-integration-association/${integration.dataIntegrationId}/*`,
    ],
    // Rerunning the on-demand job snapshots through Customer Profiles on the
    // caller's behalf.
    dependentActions: ["profile:CreateSnapshot", "profile:GetSnapshot"],
  }),
);
