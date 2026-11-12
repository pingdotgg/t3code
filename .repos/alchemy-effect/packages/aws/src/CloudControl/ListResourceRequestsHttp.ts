import * as cloudcontrol from "@distilled.cloud/aws/cloudcontrol";
import * as Layer from "effect/Layer";
import { makeCloudControlHttpBinding } from "./BindingHttp.ts";
import { ListResourceRequests } from "./ListResourceRequests.ts";

export const ListResourceRequestsHttp = Layer.effect(
  ListResourceRequests,
  makeCloudControlHttpBinding({
    tag: "AWS.CloudControl.ListResourceRequests",
    operation: cloudcontrol.listResourceRequests,
    actions: ["cloudformation:ListResourceRequests"],
  }),
);
