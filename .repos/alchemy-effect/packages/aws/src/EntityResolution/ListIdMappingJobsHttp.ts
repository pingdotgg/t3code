import * as entityresolution from "@distilled.cloud/aws/entityresolution";
import * as Layer from "effect/Layer";
import { makeWorkflowHttpBinding } from "./BindingHttp.ts";
import { ListIdMappingJobs } from "./ListIdMappingJobs.ts";

export const ListIdMappingJobsHttp = Layer.effect(
  ListIdMappingJobs,
  makeWorkflowHttpBinding({
    tag: "AWS.EntityResolution.ListIdMappingJobs",
    operation: entityresolution.listIdMappingJobs,
    actions: ["entityresolution:ListIdMappingJobs"],
  }),
);
