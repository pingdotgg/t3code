import * as bdar from "@distilled.cloud/aws/bedrock-data-automation-runtime";
import * as Layer from "effect/Layer";
import { makeBdaProjectHttpBinding } from "./BindingHttp.ts";
import { InvokeDataAutomationAsync } from "./InvokeDataAutomationAsync.ts";

export const InvokeDataAutomationAsyncHttp = Layer.effect(
  InvokeDataAutomationAsync,
  makeBdaProjectHttpBinding({
    tag: "AWS.BedrockDataAutomation.InvokeDataAutomationAsync",
    operation: bdar.invokeDataAutomationAsync,
    actions: ["bedrock:InvokeDataAutomationAsync"],
  }),
);
