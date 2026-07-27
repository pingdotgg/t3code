import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { AssociateMember } from "./AssociateMember.ts";

export const AssociateMemberHttp = Layer.effect(
  AssociateMember,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.AssociateMember",
    operation: inspector2.associateMember,
    actions: ["inspector2:AssociateMember"],
  }),
);
