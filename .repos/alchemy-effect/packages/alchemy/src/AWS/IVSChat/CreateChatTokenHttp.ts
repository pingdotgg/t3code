import * as ivschat from "@distilled.cloud/aws/ivschat";
import * as Layer from "effect/Layer";
import { toWireMinutes } from "../../Util/Duration.ts";
import { makeIvsChatRoomHttpBinding } from "./BindingHttp.ts";
import {
  CreateChatToken,
  type CreateChatTokenRequest,
} from "./CreateChatToken.ts";

export const CreateChatTokenHttp = Layer.effect(
  CreateChatToken,
  makeIvsChatRoomHttpBinding({
    tag: "AWS.IVSChat.CreateChatToken",
    operation: ivschat.createChatToken,
    actions: ["ivschat:CreateChatToken"],
    prepare: ({ sessionDuration, ...request }: CreateChatTokenRequest) => ({
      ...request,
      sessionDurationInMinutes: toWireMinutes(sessionDuration),
    }),
  }),
);
