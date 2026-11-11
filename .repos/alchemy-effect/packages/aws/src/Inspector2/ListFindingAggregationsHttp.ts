import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { ListFindingAggregations } from "./ListFindingAggregations.ts";

export const ListFindingAggregationsHttp = Layer.effect(
  ListFindingAggregations,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.ListFindingAggregations",
    operation: inspector2.listFindingAggregations,
    actions: ["inspector2:ListFindingAggregations"],
  }),
);
