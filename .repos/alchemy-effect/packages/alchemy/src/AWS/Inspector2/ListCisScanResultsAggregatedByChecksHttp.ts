import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { ListCisScanResultsAggregatedByChecks } from "./ListCisScanResultsAggregatedByChecks.ts";

export const ListCisScanResultsAggregatedByChecksHttp = Layer.effect(
  ListCisScanResultsAggregatedByChecks,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.ListCisScanResultsAggregatedByChecks",
    operation: inspector2.listCisScanResultsAggregatedByChecks,
    actions: ["inspector2:ListCisScanResultsAggregatedByChecks"],
  }),
);
