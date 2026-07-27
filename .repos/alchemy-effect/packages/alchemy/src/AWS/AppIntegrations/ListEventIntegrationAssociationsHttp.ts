import * as appintegrations from "@distilled.cloud/aws/appintegrations";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { makeAppIntegrationsHttpBinding } from "./BindingHttp.ts";
import type { EventIntegration } from "./EventIntegration.ts";
import { ListEventIntegrationAssociations } from "./ListEventIntegrationAssociations.ts";

/**
 * HTTP implementation of {@link ListEventIntegrationAssociations}. At deploy
 * time it grants `app-integrations:ListEventIntegrationAssociations` on the
 * event integration (and its `event-integration-association/*` children); at
 * runtime it calls the AppIntegrations API with the host Function's
 * credentials, injecting the event integration's name. Provide this layer on
 * the Function using the binding.
 */
export const ListEventIntegrationAssociationsHttp = Layer.effect(
  ListEventIntegrationAssociations,
  makeAppIntegrationsHttpBinding({
    name: "ListEventIntegrationAssociations",
    operation: appintegrations.listEventIntegrationAssociations,
    requestKey: "EventIntegrationName",
    identifier: (integration: EventIntegration) =>
      integration.eventIntegrationName,
    iamActions: ["app-integrations:ListEventIntegrationAssociations"],
    resources: (integration, { region, accountId }) => [
      Output.interpolate`${integration.eventIntegrationArn}`,
      Output.interpolate`arn:aws:app-integrations:${region}:${accountId}:event-integration-association/${integration.eventIntegrationName}/*`,
    ],
  }),
);
