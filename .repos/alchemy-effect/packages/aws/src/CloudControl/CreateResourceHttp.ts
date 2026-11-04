import * as cloudcontrol from "@distilled.cloud/aws/cloudcontrol";
import * as Layer from "effect/Layer";
import { makeCloudControlHttpBinding } from "./BindingHttp.ts";
import { CreateResource } from "./CreateResource.ts";

export const CreateResourceHttp = Layer.effect(
  CreateResource,
  makeCloudControlHttpBinding({
    tag: "AWS.CloudControl.CreateResource",
    operation: cloudcontrol.createResource,
    actions: ["cloudformation:CreateResource"],
  }),
);
