import * as datasync from "@distilled.cloud/aws/datasync";
import * as Layer from "effect/Layer";
import { makeDataSyncTaskHttpBinding } from "./BindingHttp.ts";
import { StartTaskExecution } from "./StartTaskExecution.ts";

export const StartTaskExecutionHttp = Layer.effect(
  StartTaskExecution,
  makeDataSyncTaskHttpBinding({
    tag: "AWS.DataSync.StartTaskExecution",
    operation: datasync.startTaskExecution,
    actions: ["datasync:StartTaskExecution"],
  }),
);
