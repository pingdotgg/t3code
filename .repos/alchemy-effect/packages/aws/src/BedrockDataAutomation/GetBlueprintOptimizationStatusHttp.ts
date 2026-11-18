import * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import * as Layer from "effect/Layer";
import { makeBdaAccountHttpBinding } from "./BindingHttp.ts";
import { GetBlueprintOptimizationStatus } from "./GetBlueprintOptimizationStatus.ts";

export const GetBlueprintOptimizationStatusHttp = Layer.effect(
  GetBlueprintOptimizationStatus,
  makeBdaAccountHttpBinding({
    tag: "AWS.BedrockDataAutomation.GetBlueprintOptimizationStatus",
    operation: bda.getBlueprintOptimizationStatus,
    actions: ["bedrock:GetBlueprintOptimizationStatus"],
  }),
);
