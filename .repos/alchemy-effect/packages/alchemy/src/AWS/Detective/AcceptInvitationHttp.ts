import * as detective from "@distilled.cloud/aws/detective";
import * as Layer from "effect/Layer";
import { makeDetectiveAccountHttpBinding } from "./BindingHttp.ts";
import { AcceptInvitation } from "./AcceptInvitation.ts";

export const AcceptInvitationHttp = Layer.effect(
  AcceptInvitation,
  makeDetectiveAccountHttpBinding({
    tag: "AWS.Detective.AcceptInvitation",
    operation: detective.acceptInvitation,
    actions: ["detective:AcceptInvitation"],
  }),
);
