import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { GetMember } from "./GetMember.ts";

export const GetMemberHttp = Layer.effect(
  GetMember,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.GetMember",
    operation: inspector2.getMember,
    actions: ["inspector2:GetMember"],
  }),
);
