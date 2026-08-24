import * as SD from "@distilled.cloud/aws/servicediscovery";
import * as Layer from "effect/Layer";
import { makeCloudMapDiscoveryHttpBinding } from "./BindingHttp.ts";
import { DiscoverInstancesRevision } from "./DiscoverInstancesRevision.ts";

export const DiscoverInstancesRevisionHttp = Layer.effect(
  DiscoverInstancesRevision,
  makeCloudMapDiscoveryHttpBinding({
    tag: "AWS.CloudMap.DiscoverInstancesRevision",
    operation: SD.discoverInstancesRevision,
    actions: ["servicediscovery:DiscoverInstancesRevision"],
  }),
);
