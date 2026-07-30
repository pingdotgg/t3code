import * as ram from "@distilled.cloud/aws/ram";
import * as Layer from "effect/Layer";
import { makeRAMHttpBinding } from "./BindingHttp.ts";
import { GetResourceShareInvitations } from "./GetResourceShareInvitations.ts";

export const GetResourceShareInvitationsHttp = Layer.effect(
  GetResourceShareInvitations,
  makeRAMHttpBinding({
    capability: "GetResourceShareInvitations",
    iamActions: ["ram:GetResourceShareInvitations"],
    operation: ram.getResourceShareInvitations,
  }),
);
