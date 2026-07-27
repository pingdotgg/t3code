import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";
import { BatchGetFindingDetails } from "./BatchGetFindingDetails.ts";

export const BatchGetFindingDetailsHttp = Layer.effect(
  BatchGetFindingDetails,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.BatchGetFindingDetails",
    operation: inspector2.batchGetFindingDetails,
    actions: ["inspector2:BatchGetFindingDetails"],
  }),
);
