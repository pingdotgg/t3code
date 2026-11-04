import * as entityresolution from "@distilled.cloud/aws/entityresolution";
import * as Layer from "effect/Layer";
import { makeWorkflowHttpBinding } from "./BindingHttp.ts";
import { StartIdMappingJob } from "./StartIdMappingJob.ts";

export const StartIdMappingJobHttp = Layer.effect(
  StartIdMappingJob,
  makeWorkflowHttpBinding({
    tag: "AWS.EntityResolution.StartIdMappingJob",
    operation: entityresolution.startIdMappingJob,
    actions: ["entityresolution:StartIdMappingJob"],
  }),
);
