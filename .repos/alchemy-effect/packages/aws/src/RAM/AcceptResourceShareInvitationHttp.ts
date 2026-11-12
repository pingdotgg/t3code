import * as ram from "@distilled.cloud/aws/ram";
import * as Layer from "effect/Layer";
import { AcceptResourceShareInvitation } from "./AcceptResourceShareInvitation.ts";
import { makeRAMHttpBinding } from "./BindingHttp.ts";

export const AcceptResourceShareInvitationHttp = Layer.effect(
  AcceptResourceShareInvitation,
  makeRAMHttpBinding({
    capability: "AcceptResourceShareInvitation",
    iamActions: ["ram:AcceptResourceShareInvitation"],
    operation: ram.acceptResourceShareInvitation,
  }),
);
