import * as cloudcontrol from "@distilled.cloud/aws/cloudcontrol";
import * as Layer from "effect/Layer";
import { makeCloudControlHttpBinding } from "./BindingHttp.ts";
import { DeleteResource } from "./DeleteResource.ts";

export const DeleteResourceHttp = Layer.effect(
  DeleteResource,
  makeCloudControlHttpBinding({
    tag: "AWS.CloudControl.DeleteResource",
    operation: cloudcontrol.deleteResource,
    actions: ["cloudformation:DeleteResource"],
  }),
);
