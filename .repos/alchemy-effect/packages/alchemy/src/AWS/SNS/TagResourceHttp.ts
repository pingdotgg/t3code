import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsTopicHttpBinding } from "./BindingHttp.ts";
import { TagResource } from "./TagResource.ts";

export const TagResourceHttp = Layer.effect(
  TagResource,
  makeSnsTopicHttpBinding({
    tag: "AWS.SNS.TagResource",
    operation: sns.tagResource,
    actions: ["sns:TagResource"],
    key: "ResourceArn",
  }),
);
