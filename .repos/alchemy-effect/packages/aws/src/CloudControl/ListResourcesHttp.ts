import * as cloudcontrol from "@distilled.cloud/aws/cloudcontrol";
import * as Layer from "effect/Layer";
import { makeCloudControlHttpBinding } from "./BindingHttp.ts";
import { ListResources } from "./ListResources.ts";

export const ListResourcesHttp = Layer.effect(
  ListResources,
  makeCloudControlHttpBinding({
    tag: "AWS.CloudControl.ListResources",
    operation: cloudcontrol.listResources,
    actions: ["cloudformation:ListResources"],
  }),
);
