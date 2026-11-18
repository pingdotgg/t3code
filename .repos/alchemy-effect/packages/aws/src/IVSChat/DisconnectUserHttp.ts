import * as ivschat from "@distilled.cloud/aws/ivschat";
import * as Layer from "effect/Layer";
import { makeIvsChatRoomHttpBinding } from "./BindingHttp.ts";
import { DisconnectUser } from "./DisconnectUser.ts";

export const DisconnectUserHttp = Layer.effect(
  DisconnectUser,
  makeIvsChatRoomHttpBinding({
    tag: "AWS.IVSChat.DisconnectUser",
    operation: ivschat.disconnectUser,
    actions: ["ivschat:DisconnectUser"],
  }),
);
