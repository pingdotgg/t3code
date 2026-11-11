import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAnalyzerScopedHttpBinding } from "./BindingHttp.ts";
import { ListFindings } from "./ListFindings.ts";

export const ListFindingsHttp = Layer.effect(
  ListFindings,
  makeAnalyzerScopedHttpBinding({
    tag: "AWS.AccessAnalyzer.ListFindings",
    operation: aa.listFindings,
    actions: ["access-analyzer:ListFindings"],
  }),
);
