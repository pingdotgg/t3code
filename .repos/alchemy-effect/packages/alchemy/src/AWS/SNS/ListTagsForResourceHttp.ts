import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsTopicHttpBinding } from "./BindingHttp.ts";
import { ListTagsForResource } from "./ListTagsForResource.ts";

export const ListTagsForResourceHttp = Layer.effect(
  ListTagsForResource,
  makeSnsTopicHttpBinding({
    tag: "AWS.SNS.ListTagsForResource",
    operation: sns.listTagsForResource,
    actions: ["sns:ListTagsForResource"],
    key: "ResourceArn",
  }),
);
