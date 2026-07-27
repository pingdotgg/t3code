import * as mm from "@distilled.cloud/aws/mailmanager";
import * as Layer from "effect/Layer";
import { makeArchiveTaskHttpBinding } from "./BindingHttp.ts";
import { GetArchiveMessageContent } from "./GetArchiveMessageContent.ts";

export const GetArchiveMessageContentHttp = Layer.effect(
  GetArchiveMessageContent,
  makeArchiveTaskHttpBinding({
    tag: "AWS.MailManager.GetArchiveMessageContent",
    operation: mm.getArchiveMessageContent,
    actions: ["ses:GetArchiveMessageContent"],
  }),
);
