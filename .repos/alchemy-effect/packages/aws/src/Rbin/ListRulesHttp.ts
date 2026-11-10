import * as rbin from "@distilled.cloud/aws/rbin";
import * as Layer from "effect/Layer";
import { makeRbinAccountHttpBinding } from "./BindingHttp.ts";
import { ListRules } from "./ListRules.ts";

export const ListRulesHttp = Layer.effect(
  ListRules,
  makeRbinAccountHttpBinding({
    tag: "AWS.Rbin.ListRules",
    operation: rbin.listRules,
    actions: ["rbin:ListRules"],
  }),
);
