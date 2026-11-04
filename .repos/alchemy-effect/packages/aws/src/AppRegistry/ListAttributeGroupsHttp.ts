import * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import * as Layer from "effect/Layer";
import { makeAppRegistryAccountHttpBinding } from "./BindingHttp.ts";
import { ListAttributeGroups } from "./ListAttributeGroups.ts";

export const ListAttributeGroupsHttp = Layer.effect(
  ListAttributeGroups,
  makeAppRegistryAccountHttpBinding({
    tag: "AWS.AppRegistry.ListAttributeGroups",
    operation: appregistry.listAttributeGroups,
    actions: ["servicecatalog:ListAttributeGroups"],
  }),
);
