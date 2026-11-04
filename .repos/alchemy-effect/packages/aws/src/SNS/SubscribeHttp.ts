import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsTopicHttpBinding } from "./BindingHttp.ts";
import { Subscribe } from "./Subscribe.ts";

export const SubscribeHttp = Layer.effect(
  Subscribe,
  makeSnsTopicHttpBinding({
    tag: "AWS.SNS.Subscribe",
    operation: sns.subscribe,
    actions: ["sns:Subscribe"],
    key: "TopicArn",
  }),
);
