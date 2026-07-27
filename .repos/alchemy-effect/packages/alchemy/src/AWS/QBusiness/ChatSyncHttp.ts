import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";
import { ChatSync } from "./ChatSync.ts";

export const ChatSyncHttp = Layer.effect(
  ChatSync,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.ChatSync",
    operation: qbusiness.chatSync,
    actions: ["qbusiness:ChatSync"],
  }),
);
