import * as bedrock from "@distilled.cloud/aws/bedrock-agent";
import * as Layer from "effect/Layer";
import { makeDataSourceScopedHttpBinding } from "./BindingHttp.ts";
import { StartIngestionJob } from "./StartIngestionJob.ts";

export const StartIngestionJobHttp = Layer.effect(
  StartIngestionJob,
  makeDataSourceScopedHttpBinding({
    tag: "AWS.Bedrock.StartIngestionJob",
    operation: bedrock.startIngestionJob,
    actions: ["bedrock:StartIngestionJob"],
  }),
);
