import * as batch from "@distilled.cloud/aws/batch";
import * as Layer from "effect/Layer";
import { makeBatchJobHttpBinding } from "./BindingHttp.ts";
import { TerminateJob } from "./TerminateJob.ts";

export const TerminateJobHttp = Layer.effect(
  TerminateJob,
  // Job ARNs (arn:…:job/{jobId}) are only known at runtime, so the statement
  // cannot enumerate them at deploy time.
  makeBatchJobHttpBinding({
    tag: "AWS.Batch.TerminateJob",
    operation: batch.terminateJob,
    actions: ["batch:TerminateJob"],
  }),
);
