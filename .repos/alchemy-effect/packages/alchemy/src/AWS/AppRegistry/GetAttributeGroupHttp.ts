import * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import * as Layer from "effect/Layer";
import { makeAttributeGroupScopedHttpBinding } from "./BindingHttp.ts";
import { GetAttributeGroup } from "./GetAttributeGroup.ts";

export const GetAttributeGroupHttp = Layer.effect(
  GetAttributeGroup,
  makeAttributeGroupScopedHttpBinding({
    tag: "AWS.AppRegistry.GetAttributeGroup",
    operation: appregistry.getAttributeGroup,
    actions: ["servicecatalog:GetAttributeGroup"],
  }),
);
