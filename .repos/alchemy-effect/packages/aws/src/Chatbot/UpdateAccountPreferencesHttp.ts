import * as chatbot from "@distilled.cloud/aws/chatbot";
import * as Layer from "effect/Layer";
import { makeChatbotAccountHttpBinding } from "./BindingHttp.ts";
import { UpdateAccountPreferences } from "./UpdateAccountPreferences.ts";

export const UpdateAccountPreferencesHttp = Layer.effect(
  UpdateAccountPreferences,
  makeChatbotAccountHttpBinding({
    tag: "AWS.Chatbot.UpdateAccountPreferences",
    operation: chatbot.updateAccountPreferences,
    actions: ["chatbot:UpdateAccountPreferences"],
  }),
);
