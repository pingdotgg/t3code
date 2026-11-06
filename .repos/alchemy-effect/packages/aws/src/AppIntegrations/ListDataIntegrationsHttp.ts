import * as appintegrations from "@distilled.cloud/aws/appintegrations";
import * as Layer from "effect/Layer";
import { makeAppIntegrationsAccountHttpBinding } from "./BindingHttp.ts";
import { ListDataIntegrations } from "./ListDataIntegrations.ts";

/**
 * HTTP implementation of {@link ListDataIntegrations}. At deploy time it
 * grants `app-integrations:ListDataIntegrations`; at runtime it calls the
 * AppIntegrations API with the host Function's credentials. Provide this
 * layer on the Function using the binding.
 */
export const ListDataIntegrationsHttp = Layer.effect(
  ListDataIntegrations,
  makeAppIntegrationsAccountHttpBinding({
    name: "ListDataIntegrations",
    operation: appintegrations.listDataIntegrations,
    iamActions: ["app-integrations:ListDataIntegrations"],
  }),
);
