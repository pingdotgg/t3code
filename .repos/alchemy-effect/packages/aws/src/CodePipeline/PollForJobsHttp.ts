import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Layer from "effect/Layer";
import { makeCodePipelineJobHttpBinding } from "./BindingHttp.ts";
import { PollForJobs } from "./PollForJobs.ts";

export const PollForJobsHttp = Layer.effect(
  PollForJobs,
  makeCodePipelineJobHttpBinding({
    tag: "AWS.CodePipeline.PollForJobs",
    operation: codepipeline.pollForJobs,
    actions: ["codepipeline:PollForJobs"],
  }),
);
