import * as bedrock from "@distilled.cloud/aws/bedrock-agent";
import * as Layer from "effect/Layer";
import { makeDataSourceScopedHttpBinding } from "./BindingHttp.ts";
import { StopIngestionJob } from "./StopIngestionJob.ts";

export const StopIngestionJobHttp = Layer.effect(
  StopIngestionJob,
  makeDataSourceScopedHttpBinding({
    tag: "AWS.Bedrock.StopIngestionJob",
    operation: bedrock.stopIngestionJob,
    actions: ["bedrock:StopIngestionJob"],
  }),
);
