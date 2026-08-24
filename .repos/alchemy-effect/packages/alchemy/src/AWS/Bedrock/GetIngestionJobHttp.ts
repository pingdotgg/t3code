import * as bedrock from "@distilled.cloud/aws/bedrock-agent";
import * as Layer from "effect/Layer";
import { makeDataSourceScopedHttpBinding } from "./BindingHttp.ts";
import { GetIngestionJob } from "./GetIngestionJob.ts";

export const GetIngestionJobHttp = Layer.effect(
  GetIngestionJob,
  makeDataSourceScopedHttpBinding({
    tag: "AWS.Bedrock.GetIngestionJob",
    operation: bedrock.getIngestionJob,
    actions: ["bedrock:GetIngestionJob"],
  }),
);
