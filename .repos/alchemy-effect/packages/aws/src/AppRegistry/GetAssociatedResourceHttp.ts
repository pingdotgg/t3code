import * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import * as Layer from "effect/Layer";
import { makeApplicationScopedHttpBinding } from "./BindingHttp.ts";
import { GetAssociatedResource } from "./GetAssociatedResource.ts";

export const GetAssociatedResourceHttp = Layer.effect(
  GetAssociatedResource,
  makeApplicationScopedHttpBinding({
    tag: "AWS.AppRegistry.GetAssociatedResource",
    operation: appregistry.getAssociatedResource,
    actions: ["servicecatalog:GetAssociatedResource"],
  }),
);
