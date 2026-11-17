import * as datasync from "@distilled.cloud/aws/datasync";
import * as Layer from "effect/Layer";
import { makeDataSyncTaskHttpBinding } from "./BindingHttp.ts";
import { DescribeTask } from "./DescribeTask.ts";

export const DescribeTaskHttp = Layer.effect(
  DescribeTask,
  makeDataSyncTaskHttpBinding({
    tag: "AWS.DataSync.DescribeTask",
    operation: datasync.describeTask,
    actions: ["datasync:DescribeTask"],
  }),
);
