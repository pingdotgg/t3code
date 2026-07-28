import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Layer from "effect/Layer";
import { makeArchiveTaskHttpBinding } from "./BindingHttp.ts";
import { GetArchiveMessage } from "./GetArchiveMessage.ts";

export const GetArchiveMessageHttp = Layer.effect(
  GetArchiveMessage,
  makeArchiveTaskHttpBinding({
    tag: "AWS.MailManager.GetArchiveMessage",
    operation: mm.getArchiveMessage,
    actions: ["ses:GetArchiveMessage"],
  }),
);
