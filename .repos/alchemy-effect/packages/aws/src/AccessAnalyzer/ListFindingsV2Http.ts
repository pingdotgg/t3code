import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Layer from "effect/Layer";
import { makeAnalyzerScopedHttpBinding } from "./BindingHttp.ts";
import { ListFindingsV2 } from "./ListFindingsV2.ts";

export const ListFindingsV2Http = Layer.effect(
  ListFindingsV2,
  makeAnalyzerScopedHttpBinding({
    tag: "AWS.AccessAnalyzer.ListFindingsV2",
    operation: aa.listFindingsV2,
    // ListFindings and ListFindingsV2 both use `access-analyzer:ListFindings`.
    actions: ["access-analyzer:ListFindings"],
  }),
);
