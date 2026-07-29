import * as SD from "@distilled.cloud/aws/servicediscovery";
import * as Layer from "effect/Layer";
import { makeCloudMapServiceHttpBinding } from "./BindingHttp.ts";
import { UpdateInstanceCustomHealthStatus } from "./UpdateInstanceCustomHealthStatus.ts";

export const UpdateInstanceCustomHealthStatusHttp = Layer.effect(
  UpdateInstanceCustomHealthStatus,
  makeCloudMapServiceHttpBinding({
    tag: "AWS.CloudMap.UpdateInstanceCustomHealthStatus",
    operation: SD.updateInstanceCustomHealthStatus,
    actions: ["servicediscovery:UpdateInstanceCustomHealthStatus"],
  }),
);
