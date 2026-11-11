import * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import * as Layer from "effect/Layer";
import { makeBdaBlueprintOptimizationHttpBinding } from "./BindingHttp.ts";
import { InvokeBlueprintOptimizationAsync } from "./InvokeBlueprintOptimizationAsync.ts";

export const InvokeBlueprintOptimizationAsyncHttp = Layer.effect(
  InvokeBlueprintOptimizationAsync,
  makeBdaBlueprintOptimizationHttpBinding({
    tag: "AWS.BedrockDataAutomation.InvokeBlueprintOptimizationAsync",
    operation: bda.invokeBlueprintOptimizationAsync,
    actions: ["bedrock:InvokeBlueprintOptimizationAsync"],
  }),
);
