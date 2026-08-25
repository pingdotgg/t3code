import * as chatbot from "@distilled.cloud/aws/chatbot";
import * as Layer from "effect/Layer";
import { makeChatbotAccountHttpBinding } from "./BindingHttp.ts";
import { GetAccountPreferences } from "./GetAccountPreferences.ts";

export const GetAccountPreferencesHttp = Layer.effect(
  GetAccountPreferences,
  makeChatbotAccountHttpBinding({
    tag: "AWS.Chatbot.GetAccountPreferences",
    operation: chatbot.getAccountPreferences,
    actions: ["chatbot:GetAccountPreferences"],
  }),
);
