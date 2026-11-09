import * as bdar from "@distilled.cloud/aws/bedrock-data-automation-runtime";
import * as Layer from "effect/Layer";
import { makeBdaAccountHttpBinding } from "./BindingHttp.ts";
import { GetDataAutomationStatus } from "./GetDataAutomationStatus.ts";

export const GetDataAutomationStatusHttp = Layer.effect(
  GetDataAutomationStatus,
  makeBdaAccountHttpBinding({
    tag: "AWS.BedrockDataAutomation.GetDataAutomationStatus",
    operation: bdar.getDataAutomationStatus,
    actions: ["bedrock:GetDataAutomationStatus"],
  }),
);
