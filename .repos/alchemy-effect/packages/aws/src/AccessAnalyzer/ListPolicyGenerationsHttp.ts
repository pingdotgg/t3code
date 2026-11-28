import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAccessAnalyzerAccountHttpBinding } from "./BindingHttp.ts";
import { ListPolicyGenerations } from "./ListPolicyGenerations.ts";

export const ListPolicyGenerationsHttp = Layer.effect(
  ListPolicyGenerations,
  makeAccessAnalyzerAccountHttpBinding({
    tag: "AWS.AccessAnalyzer.ListPolicyGenerations",
    operation: aa.listPolicyGenerations,
    actions: ["access-analyzer:ListPolicyGenerations"],
  }),
);
