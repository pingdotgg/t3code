import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { ListDiscoveredResources } from "./ListDiscoveredResources.ts";

export const ListDiscoveredResourcesHttp = Layer.effect(
  ListDiscoveredResources,
  makeFmsHttpBinding({
    capability: "ListDiscoveredResources",
    iamActions: ["fms:ListDiscoveredResources"],
    operation: fms.listDiscoveredResources,
  }),
);
