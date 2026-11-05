import * as entityresolution from "@distilled.cloud/aws/entityresolution";
import * as Layer from "effect/Layer";
import { makeWorkflowHttpBinding } from "./BindingHttp.ts";
import { GetMatchingJob } from "./GetMatchingJob.ts";

export const GetMatchingJobHttp = Layer.effect(
  GetMatchingJob,
  makeWorkflowHttpBinding({
    tag: "AWS.EntityResolution.GetMatchingJob",
    operation: entityresolution.getMatchingJob,
    actions: ["entityresolution:GetMatchingJob"],
  }),
);
