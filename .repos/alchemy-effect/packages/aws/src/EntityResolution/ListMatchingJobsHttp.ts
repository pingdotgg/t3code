import * as entityresolution from "@distilled.cloud/aws/entityresolution";
import * as Layer from "effect/Layer";
import { makeWorkflowHttpBinding } from "./BindingHttp.ts";
import { ListMatchingJobs } from "./ListMatchingJobs.ts";

export const ListMatchingJobsHttp = Layer.effect(
  ListMatchingJobs,
  makeWorkflowHttpBinding({
    tag: "AWS.EntityResolution.ListMatchingJobs",
    operation: entityresolution.listMatchingJobs,
    actions: ["entityresolution:ListMatchingJobs"],
  }),
);
