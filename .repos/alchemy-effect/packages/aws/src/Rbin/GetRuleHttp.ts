import * as rbin from "@distilled.cloud/aws/rbin";
import * as Layer from "effect/Layer";
import { makeRbinRuleHttpBinding } from "./BindingHttp.ts";
import { GetRule } from "./GetRule.ts";

export const GetRuleHttp = Layer.effect(
  GetRule,
  makeRbinRuleHttpBinding({
    tag: "AWS.Rbin.GetRule",
    operation: rbin.getRule,
    actions: ["rbin:GetRule"],
  }),
);
