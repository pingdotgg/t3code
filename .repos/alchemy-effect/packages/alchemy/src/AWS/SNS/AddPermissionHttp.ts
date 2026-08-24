import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsTopicHttpBinding } from "./BindingHttp.ts";
import { AddPermission } from "./AddPermission.ts";

export const AddPermissionHttp = Layer.effect(
  AddPermission,
  makeSnsTopicHttpBinding({
    tag: "AWS.SNS.AddPermission",
    operation: sns.addPermission,
    actions: ["sns:AddPermission"],
    key: "TopicArn",
  }),
);
