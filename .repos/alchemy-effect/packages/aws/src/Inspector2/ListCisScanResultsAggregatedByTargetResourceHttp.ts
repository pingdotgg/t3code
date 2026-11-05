import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { ListCisScanResultsAggregatedByTargetResource } from "./ListCisScanResultsAggregatedByTargetResource.ts";

export const ListCisScanResultsAggregatedByTargetResourceHttp = Layer.effect(
  ListCisScanResultsAggregatedByTargetResource,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.ListCisScanResultsAggregatedByTargetResource",
    operation: inspector2.listCisScanResultsAggregatedByTargetResource,
    actions: ["inspector2:ListCisScanResultsAggregatedByTargetResource"],
  }),
);
