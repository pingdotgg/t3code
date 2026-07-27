import * as ram from "@distilled.cloud/aws/ram";
import * as Layer from "effect/Layer";
import { makeRAMHttpBinding } from "./BindingHttp.ts";
import { RejectResourceShareInvitation } from "./RejectResourceShareInvitation.ts";

export const RejectResourceShareInvitationHttp = Layer.effect(
  RejectResourceShareInvitation,
  makeRAMHttpBinding({
    capability: "RejectResourceShareInvitation",
    iamActions: ["ram:RejectResourceShareInvitation"],
    operation: ram.rejectResourceShareInvitation,
  }),
);
