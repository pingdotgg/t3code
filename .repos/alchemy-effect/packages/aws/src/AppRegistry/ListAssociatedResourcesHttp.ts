import * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import * as Layer from "effect/Layer";
import { makeApplicationScopedHttpBinding } from "./BindingHttp.ts";
import { ListAssociatedResources } from "./ListAssociatedResources.ts";

export const ListAssociatedResourcesHttp = Layer.effect(
  ListAssociatedResources,
  makeApplicationScopedHttpBinding({
    tag: "AWS.AppRegistry.ListAssociatedResources",
    operation: appregistry.listAssociatedResources,
    actions: ["servicecatalog:ListAssociatedResources"],
  }),
);
