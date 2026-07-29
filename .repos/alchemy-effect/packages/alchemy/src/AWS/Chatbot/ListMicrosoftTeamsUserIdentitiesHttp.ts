import * as chatbot from "@distilled.cloud/aws/chatbot";
import * as Layer from "effect/Layer";
import { makeChatbotAccountHttpBinding } from "./BindingHttp.ts";
import { ListMicrosoftTeamsUserIdentities } from "./ListMicrosoftTeamsUserIdentities.ts";

export const ListMicrosoftTeamsUserIdentitiesHttp = Layer.effect(
  ListMicrosoftTeamsUserIdentities,
  makeChatbotAccountHttpBinding({
    tag: "AWS.Chatbot.ListMicrosoftTeamsUserIdentities",
    operation: chatbot.listMicrosoftTeamsUserIdentities,
    actions: ["chatbot:ListMicrosoftTeamsUserIdentities"],
  }),
);
