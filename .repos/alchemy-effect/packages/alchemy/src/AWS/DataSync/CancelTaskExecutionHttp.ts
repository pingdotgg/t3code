import * as datasync from "@distilled.cloud/aws/datasync";
import * as Layer from "effect/Layer";
import { makeDataSyncTaskExecutionHttpBinding } from "./BindingHttp.ts";
import { CancelTaskExecution } from "./CancelTaskExecution.ts";

export const CancelTaskExecutionHttp = Layer.effect(
  CancelTaskExecution,
  makeDataSyncTaskExecutionHttpBinding({
    tag: "AWS.DataSync.CancelTaskExecution",
    operation: datasync.cancelTaskExecution,
    actions: ["datasync:CancelTaskExecution"],
  }),
);
