import * as chatbot from "@distilled.cloud/aws/chatbot";
import * as Layer from "effect/Layer";
import { makeChatbotAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeSlackUserIdentities } from "./DescribeSlackUserIdentities.ts";

export const DescribeSlackUserIdentitiesHttp = Layer.effect(
  DescribeSlackUserIdentities,
  makeChatbotAccountHttpBinding({
    tag: "AWS.Chatbot.DescribeSlackUserIdentities",
    operation: chatbot.describeSlackUserIdentities,
    actions: ["chatbot:DescribeSlackUserIdentities"],
  }),
);
