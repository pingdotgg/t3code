import * as batch from "@distilled.cloud/aws/batch";
import * as Layer from "effect/Layer";
import { makeBatchQueueHttpBinding } from "./BindingHttp.ts";
import { ListJobs } from "./ListJobs.ts";

export const ListJobsHttp = Layer.effect(
  ListJobs,
  // batch:ListJobs does not support resource-level IAM.
  makeBatchQueueHttpBinding({
    tag: "AWS.Batch.ListJobs",
    operation: batch.listJobs,
    actions: ["batch:ListJobs"],
    wildcardIam: true,
  }),
);
