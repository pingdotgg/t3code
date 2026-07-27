import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";
import { DisassociateMember } from "./DisassociateMember.ts";

export const DisassociateMemberHttp = Layer.effect(
  DisassociateMember,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.DisassociateMember",
    operation: macie2.disassociateMember,
    actions: ["macie2:DisassociateMember"],
  }),
);
