import * as SD from "@distilled.cloud/aws/servicediscovery";
import * as Layer from "effect/Layer";
import { makeCloudMapServiceHttpBinding } from "./BindingHttp.ts";
import { GetInstancesHealthStatus } from "./GetInstancesHealthStatus.ts";

export const GetInstancesHealthStatusHttp = Layer.effect(
  GetInstancesHealthStatus,
  makeCloudMapServiceHttpBinding({
    tag: "AWS.CloudMap.GetInstancesHealthStatus",
    operation: SD.getInstancesHealthStatus,
    actions: ["servicediscovery:GetInstancesHealthStatus"],
  }),
);
