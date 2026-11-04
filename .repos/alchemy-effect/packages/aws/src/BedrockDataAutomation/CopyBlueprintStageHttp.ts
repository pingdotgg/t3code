import * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import * as Layer from "effect/Layer";
import { makeBdaBlueprintHttpBinding } from "./BindingHttp.ts";
import { CopyBlueprintStage } from "./CopyBlueprintStage.ts";

export const CopyBlueprintStageHttp = Layer.effect(
  CopyBlueprintStage,
  makeBdaBlueprintHttpBinding({
    tag: "AWS.BedrockDataAutomation.CopyBlueprintStage",
    operation: bda.copyBlueprintStage,
    actions: ["bedrock:CopyBlueprintStage"],
  }),
);
