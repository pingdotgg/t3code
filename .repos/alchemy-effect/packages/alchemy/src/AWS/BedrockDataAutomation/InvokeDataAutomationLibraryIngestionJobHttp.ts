import * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import * as Layer from "effect/Layer";
import { makeBdaLibraryHttpBinding } from "./BindingHttp.ts";
import { InvokeDataAutomationLibraryIngestionJob } from "./InvokeDataAutomationLibraryIngestionJob.ts";

export const InvokeDataAutomationLibraryIngestionJobHttp = Layer.effect(
  InvokeDataAutomationLibraryIngestionJob,
  makeBdaLibraryHttpBinding({
    tag: "AWS.BedrockDataAutomation.InvokeDataAutomationLibraryIngestionJob",
    operation: bda.invokeDataAutomationLibraryIngestionJob,
    actions: ["bedrock:InvokeDataAutomationLibraryIngestionJob"],
    // The action authorizes against the ingestion-job resource (minted at
    // runtime), not the library ARN.
    additionalResources: [
      "arn:aws:bedrock:*:*:data-automation-library-ingestion-job/*",
    ],
  }),
);
