import * as batch from "@distilled.cloud/aws/batch";
import * as Layer from "effect/Layer";
import { makeBatchJobHttpBinding } from "./BindingHttp.ts";
import { CancelJob } from "./CancelJob.ts";

export const CancelJobHttp = Layer.effect(
  CancelJob,
  // Job ARNs (arn:…:job/{jobId}) are only known at runtime, so the statement
  // cannot enumerate them at deploy time.
  makeBatchJobHttpBinding({
    tag: "AWS.Batch.CancelJob",
    operation: batch.cancelJob,
    actions: ["batch:CancelJob"],
  }),
);
