import * as detective from "@distilled.cloud/aws/detective";
import * as Layer from "effect/Layer";
import { makeDetectiveAccountHttpBinding } from "./BindingHttp.ts";
import { DisassociateMembership } from "./DisassociateMembership.ts";

export const DisassociateMembershipHttp = Layer.effect(
  DisassociateMembership,
  makeDetectiveAccountHttpBinding({
    tag: "AWS.Detective.DisassociateMembership",
    operation: detective.disassociateMembership,
    actions: ["detective:DisassociateMembership"],
  }),
);
