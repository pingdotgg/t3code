import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { BatchStopJobRun } from "./BatchStopJobRun.ts";
import { makeGlueJobHttpBinding } from "./BindingHttp.ts";

export const BatchStopJobRunHttp = Layer.effect(
  BatchStopJobRun,
  makeGlueJobHttpBinding({
    tag: "AWS.Glue.BatchStopJobRun",
    operation: glue.batchStopJobRun,
    actions: ["glue:BatchStopJobRun"],
  }),
);
