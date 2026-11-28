import * as datasync from "@distilled.cloud/aws/datasync";
import * as Layer from "effect/Layer";
import { makeDataSyncTaskExecutionHttpBinding } from "./BindingHttp.ts";
import { UpdateTaskExecution } from "./UpdateTaskExecution.ts";

export const UpdateTaskExecutionHttp = Layer.effect(
  UpdateTaskExecution,
  makeDataSyncTaskExecutionHttpBinding({
    tag: "AWS.DataSync.UpdateTaskExecution",
    operation: datasync.updateTaskExecution,
    actions: ["datasync:UpdateTaskExecution"],
  }),
);
