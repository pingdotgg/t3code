import * as config from "@distilled.cloud/aws/config-service";
import * as Layer from "effect/Layer";
import { makeConfigAccountHttpBinding } from "./BindingHttp.ts";
import { GetDiscoveredResourceCounts } from "./GetDiscoveredResourceCounts.ts";

export const GetDiscoveredResourceCountsHttp = Layer.effect(
  GetDiscoveredResourceCounts,
  makeConfigAccountHttpBinding({
    tag: "AWS.Config.GetDiscoveredResourceCounts",
    operation: config.getDiscoveredResourceCounts,
    actions: ["config:GetDiscoveredResourceCounts"],
  }),
);
