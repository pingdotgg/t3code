import * as batch from "@distilled.cloud/aws/batch";
import * as Layer from "effect/Layer";
import { makeBatchQueueHttpBinding } from "./BindingHttp.ts";
import { GetJobQueueSnapshot } from "./GetJobQueueSnapshot.ts";

export const GetJobQueueSnapshotHttp = Layer.effect(
  GetJobQueueSnapshot,
  // batch:GetJobQueueSnapshot supports the job-queue resource type — scope
  // the grant to the bound queue's ARN.
  makeBatchQueueHttpBinding({
    tag: "AWS.Batch.GetJobQueueSnapshot",
    operation: batch.getJobQueueSnapshot,
    actions: ["batch:GetJobQueueSnapshot"],
  }),
);
