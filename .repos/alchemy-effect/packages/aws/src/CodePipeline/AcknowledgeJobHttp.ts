import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Layer from "effect/Layer";
import { AcknowledgeJob } from "./AcknowledgeJob.ts";
import { makeCodePipelineJobHttpBinding } from "./BindingHttp.ts";

export const AcknowledgeJobHttp = Layer.effect(
  AcknowledgeJob,
  makeCodePipelineJobHttpBinding({
    tag: "AWS.CodePipeline.AcknowledgeJob",
    operation: codepipeline.acknowledgeJob,
    actions: ["codepipeline:AcknowledgeJob"],
  }),
);
