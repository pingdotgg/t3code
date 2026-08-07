import * as appintegrations from "@distilled.cloud/aws/appintegrations";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { makeAppIntegrationsHttpBinding } from "./BindingHttp.ts";
import { CreateDataIntegrationAssociation } from "./CreateDataIntegrationAssociation.ts";
import type { DataIntegration } from "./DataIntegration.ts";

/**
 * HTTP implementation of {@link CreateDataIntegrationAssociation}. At deploy
 * time it grants `app-integrations:CreateDataIntegrationAssociation` on the
 * data integration (and its `data-integration-association/*` children); at
 * runtime it calls the AppIntegrations API with the host Function's
 * credentials, injecting the data integration's id. Provide this layer on
 * the Function using the binding.
 */
export const CreateDataIntegrationAssociationHttp = Layer.effect(
  CreateDataIntegrationAssociation,
  makeAppIntegrationsHttpBinding({
    name: "CreateDataIntegrationAssociation",
    operation: appintegrations.createDataIntegrationAssociation,
    requestKey: "DataIntegrationIdentifier",
    identifier: (integration: DataIntegration) => integration.dataIntegrationId,
    iamActions: ["app-integrations:CreateDataIntegrationAssociation"],
    resources: (integration, { region, accountId }) => [
      Output.interpolate`${integration.dataIntegrationArn}`,
      Output.interpolate`arn:aws:app-integrations:${region}:${accountId}:data-integration-association/${integration.dataIntegrationId}/*`,
    ],
    // AppIntegrations provisions an AppFlow flow (and Customer Profiles
    // snapshots) on the caller's behalf when an association is created.
    dependentActions: [
      "appflow:CreateFlow",
      "appflow:DeleteFlow",
      "appflow:DescribeConnectorEntity",
      "appflow:DescribeConnectorProfiles",
      "appflow:TagResource",
      "appflow:UseConnectorProfile",
      "profile:CreateSnapshot",
      "profile:GetSnapshot",
    ],
  }),
);
