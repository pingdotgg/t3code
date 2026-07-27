import * as ivschat from "@distilled.cloud/aws/ivschat";
import * as Layer from "effect/Layer";
import { makeIvsChatRoomHttpBinding } from "./BindingHttp.ts";
import { DeleteMessage } from "./DeleteMessage.ts";

export const DeleteMessageHttp = Layer.effect(
  DeleteMessage,
  makeIvsChatRoomHttpBinding({
    tag: "AWS.IVSChat.DeleteMessage",
    operation: ivschat.deleteMessage,
    actions: ["ivschat:DeleteMessage"],
  }),
);
