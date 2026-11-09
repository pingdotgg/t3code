import * as codepipeline from "@distilled.cloud/aws/codepipeline";
import * as Layer from "effect/Layer";
import { makeCodePipelineJobHttpBinding } from "./BindingHttp.ts";
import { GetJobDetails } from "./GetJobDetails.ts";

export const GetJobDetailsHttp = Layer.effect(
  GetJobDetails,
  makeCodePipelineJobHttpBinding({
    tag: "AWS.CodePipeline.GetJobDetails",
    operation: codepipeline.getJobDetails,
    actions: ["codepipeline:GetJobDetails"],
  }),
);
