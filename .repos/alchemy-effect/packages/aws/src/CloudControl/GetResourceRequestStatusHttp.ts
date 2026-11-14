import * as cloudcontrol from "@distilled.cloud/aws/cloudcontrol";
import * as Layer from "effect/Layer";
import { makeCloudControlHttpBinding } from "./BindingHttp.ts";
import { GetResourceRequestStatus } from "./GetResourceRequestStatus.ts";

export const GetResourceRequestStatusHttp = Layer.effect(
  GetResourceRequestStatus,
  makeCloudControlHttpBinding({
    tag: "AWS.CloudControl.GetResourceRequestStatus",
    operation: cloudcontrol.getResourceRequestStatus,
    actions: ["cloudformation:GetResourceRequestStatus"],
  }),
);
