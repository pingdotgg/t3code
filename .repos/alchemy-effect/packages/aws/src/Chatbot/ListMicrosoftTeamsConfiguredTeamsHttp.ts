import * as chatbot from "@distilled.cloud/aws/chatbot";
import * as Layer from "effect/Layer";
import { makeChatbotAccountHttpBinding } from "./BindingHttp.ts";
import { ListMicrosoftTeamsConfiguredTeams } from "./ListMicrosoftTeamsConfiguredTeams.ts";

export const ListMicrosoftTeamsConfiguredTeamsHttp = Layer.effect(
  ListMicrosoftTeamsConfiguredTeams,
  makeChatbotAccountHttpBinding({
    tag: "AWS.Chatbot.ListMicrosoftTeamsConfiguredTeams",
    operation: chatbot.listMicrosoftTeamsConfiguredTeams,
    actions: ["chatbot:ListMicrosoftTeamsConfiguredTeams"],
  }),
);
