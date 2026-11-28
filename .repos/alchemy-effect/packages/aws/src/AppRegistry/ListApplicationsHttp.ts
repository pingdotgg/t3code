import * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import * as Layer from "effect/Layer";
import { makeAppRegistryAccountHttpBinding } from "./BindingHttp.ts";
import { ListApplications } from "./ListApplications.ts";

export const ListApplicationsHttp = Layer.effect(
  ListApplications,
  makeAppRegistryAccountHttpBinding({
    tag: "AWS.AppRegistry.ListApplications",
    operation: appregistry.listApplications,
    actions: ["servicecatalog:ListApplications"],
  }),
);
