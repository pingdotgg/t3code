import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsTopicHttpBinding } from "./BindingHttp.ts";
import { UntagResource } from "./UntagResource.ts";

export const UntagResourceHttp = Layer.effect(
  UntagResource,
  makeSnsTopicHttpBinding({
    tag: "AWS.SNS.UntagResource",
    operation: sns.untagResource,
    actions: ["sns:UntagResource"],
    key: "ResourceArn",
  }),
);
