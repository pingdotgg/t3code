import * as appintegrations from "@distilled.cloud/aws/appintegrations";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import type { Application } from "./Application.ts";
import { makeAppIntegrationsHttpBinding } from "./BindingHttp.ts";
import { ListApplicationAssociations } from "./ListApplicationAssociations.ts";

/**
 * HTTP implementation of {@link ListApplicationAssociations}. At deploy time
 * it grants `app-integrations:ListApplicationAssociations` on the application
 * (and its `application-association/*` children); at runtime it calls the
 * AppIntegrations API with the host Function's credentials, injecting the
 * application's id. Provide this layer on the Function using the binding.
 */
export const ListApplicationAssociationsHttp = Layer.effect(
  ListApplicationAssociations,
  makeAppIntegrationsHttpBinding({
    name: "ListApplicationAssociations",
    operation: appintegrations.listApplicationAssociations,
    requestKey: "ApplicationId",
    identifier: (application: Application) => application.applicationId,
    iamActions: ["app-integrations:ListApplicationAssociations"],
    resources: (application, { region, accountId }) => [
      Output.interpolate`${application.applicationArn}`,
      Output.interpolate`arn:aws:app-integrations:${region}:${accountId}:application-association/${application.applicationId}/*`,
    ],
  }),
);
