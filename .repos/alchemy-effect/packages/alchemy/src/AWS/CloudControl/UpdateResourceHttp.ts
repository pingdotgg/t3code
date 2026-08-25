import * as cloudcontrol from "@distilled.cloud/aws/cloudcontrol";
import * as Layer from "effect/Layer";
import { makeCloudControlHttpBinding } from "./BindingHttp.ts";
import { UpdateResource } from "./UpdateResource.ts";

export const UpdateResourceHttp = Layer.effect(
  UpdateResource,
  makeCloudControlHttpBinding({
    tag: "AWS.CloudControl.UpdateResource",
    operation: cloudcontrol.updateResource,
    actions: ["cloudformation:UpdateResource"],
  }),
);
