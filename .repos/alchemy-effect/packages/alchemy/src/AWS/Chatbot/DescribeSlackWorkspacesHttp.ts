import * as chatbot from "@distilled.cloud/aws/chatbot";
import * as Layer from "effect/Layer";
import { makeChatbotAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeSlackWorkspaces } from "./DescribeSlackWorkspaces.ts";

export const DescribeSlackWorkspacesHttp = Layer.effect(
  DescribeSlackWorkspaces,
  makeChatbotAccountHttpBinding({
    tag: "AWS.Chatbot.DescribeSlackWorkspaces",
    operation: chatbot.describeSlackWorkspaces,
    actions: ["chatbot:DescribeSlackWorkspaces"],
  }),
);
