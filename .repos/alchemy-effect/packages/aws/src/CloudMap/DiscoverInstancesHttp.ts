import * as SD from "@distilled.cloud/aws/servicediscovery";
import * as Layer from "effect/Layer";
import { makeCloudMapDiscoveryHttpBinding } from "./BindingHttp.ts";
import { DiscoverInstances } from "./DiscoverInstances.ts";

export const DiscoverInstancesHttp = Layer.effect(
  DiscoverInstances,
  makeCloudMapDiscoveryHttpBinding({
    tag: "AWS.CloudMap.DiscoverInstances",
    operation: SD.discoverInstances,
    actions: ["servicediscovery:DiscoverInstances"],
  }),
);
