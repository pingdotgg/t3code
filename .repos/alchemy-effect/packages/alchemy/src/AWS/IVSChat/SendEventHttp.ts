import * as ivschat from "@distilled.cloud/aws/ivschat";
import * as Layer from "effect/Layer";
import { makeIvsChatRoomHttpBinding } from "./BindingHttp.ts";
import { SendEvent } from "./SendEvent.ts";

export const SendEventHttp = Layer.effect(
  SendEvent,
  makeIvsChatRoomHttpBinding({
    tag: "AWS.IVSChat.SendEvent",
    operation: ivschat.sendEvent,
    actions: ["ivschat:SendEvent"],
  }),
);
