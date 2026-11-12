import * as config from "@distilled.cloud/aws/config-service";
import * as Layer from "effect/Layer";
import { makeConfigAccountHttpBinding } from "./BindingHttp.ts";
import { ListDiscoveredResources } from "./ListDiscoveredResources.ts";

export const ListDiscoveredResourcesHttp = Layer.effect(
  ListDiscoveredResources,
  makeConfigAccountHttpBinding({
    tag: "AWS.Config.ListDiscoveredResources",
    operation: config.listDiscoveredResources,
    actions: ["config:ListDiscoveredResources"],
  }),
);
