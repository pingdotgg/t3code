import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { ListCoverageStatistics } from "./ListCoverageStatistics.ts";

export const ListCoverageStatisticsHttp = Layer.effect(
  ListCoverageStatistics,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.ListCoverageStatistics",
    operation: inspector2.listCoverageStatistics,
    actions: ["inspector2:ListCoverageStatistics"],
  }),
);
