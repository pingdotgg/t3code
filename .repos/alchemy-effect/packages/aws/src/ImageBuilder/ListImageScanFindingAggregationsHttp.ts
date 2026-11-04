import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Layer from "effect/Layer";
import { makeImageBuilderAccountHttpBinding } from "./BindingHttp.ts";
import { ListImageScanFindingAggregations } from "./ListImageScanFindingAggregations.ts";

export const ListImageScanFindingAggregationsHttp = Layer.effect(
  ListImageScanFindingAggregations,
  makeImageBuilderAccountHttpBinding({
    tag: "AWS.ImageBuilder.ListImageScanFindingAggregations",
    operation: imagebuilder.listImageScanFindingAggregations,
    // Image Builder serves scan aggregations from Amazon Inspector, so the
    // API authorizes the dependent inspector2 action too — without it the
    // call fails with AccessDeniedException even when the imagebuilder
    // action is granted.
    actions: [
      "imagebuilder:ListImageScanFindingAggregations",
      "inspector2:ListFindingAggregations",
    ],
  }),
);
