import * as ram from "@distilled.cloud/aws/ram";
import * as Layer from "effect/Layer";
import { makeRAMHttpBinding } from "./BindingHttp.ts";
import { AcceptResourceShareInvitation } from "./AcceptResourceShareInvitation.ts";

export const AcceptResourceShareInvitationHttp = Layer.effect(
  AcceptResourceShareInvitation,
  makeRAMHttpBinding({
    capability: "AcceptResourceShareInvitation",
    iamActions: ["ram:AcceptResourceShareInvitation"],
    operation: ram.acceptResourceShareInvitation,
  }),
);
