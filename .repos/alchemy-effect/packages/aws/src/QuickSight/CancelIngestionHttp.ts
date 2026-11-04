import * as quicksight from "@distilled.cloud/aws/quicksight";
import * as Layer from "effect/Layer";
import { makeQuickSightDataSetHttpBinding } from "./BindingHttp.ts";
import { CancelIngestion } from "./CancelIngestion.ts";

export const CancelIngestionHttp = Layer.effect(
  CancelIngestion,
  makeQuickSightDataSetHttpBinding({
    tag: "AWS.QuickSight.CancelIngestion",
    operation: quicksight.cancelIngestion,
    actions: ["quicksight:CancelIngestion"],
  }),
);
