import * as detective from "@distilled.cloud/aws/detective";
import * as Layer from "effect/Layer";
import { AcceptInvitation } from "./AcceptInvitation.ts";
import { makeDetectiveAccountHttpBinding } from "./BindingHttp.ts";

export const AcceptInvitationHttp = Layer.effect(
  AcceptInvitation,
  makeDetectiveAccountHttpBinding({
    tag: "AWS.Detective.AcceptInvitation",
    operation: detective.acceptInvitation,
    actions: ["detective:AcceptInvitation"],
  }),
);
