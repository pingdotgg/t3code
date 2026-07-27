import * as appintegrations from "@distilled.cloud/aws/appintegrations";
import * as Layer from "effect/Layer";
import { makeAppIntegrationsAccountHttpBinding } from "./BindingHttp.ts";
import { ListApplications } from "./ListApplications.ts";

/**
 * HTTP implementation of {@link ListApplications}. At deploy time it grants
 * `app-integrations:ListApplications`; at runtime it calls the
 * AppIntegrations API with the host Function's credentials. Provide this
 * layer on the Function using the binding.
 */
export const ListApplicationsHttp = Layer.effect(
  ListApplications,
  makeAppIntegrationsAccountHttpBinding({
    name: "ListApplications",
    operation: appintegrations.listApplications,
    iamActions: ["app-integrations:ListApplications"],
  }),
);
