import * as datasync from "@distilled.cloud/aws/datasync";
import * as Layer from "effect/Layer";
import { makeDataSyncTaskExecutionHttpBinding } from "./BindingHttp.ts";
import { DescribeTaskExecution } from "./DescribeTaskExecution.ts";

export const DescribeTaskExecutionHttp = Layer.effect(
  DescribeTaskExecution,
  makeDataSyncTaskExecutionHttpBinding({
    tag: "AWS.DataSync.DescribeTaskExecution",
    operation: datasync.describeTaskExecution,
    actions: ["datasync:DescribeTaskExecution"],
  }),
);
