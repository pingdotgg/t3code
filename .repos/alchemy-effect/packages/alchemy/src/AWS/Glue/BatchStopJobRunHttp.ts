import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { makeGlueJobHttpBinding } from "./BindingHttp.ts";
import { BatchStopJobRun } from "./BatchStopJobRun.ts";

export const BatchStopJobRunHttp = Layer.effect(
  BatchStopJobRun,
  makeGlueJobHttpBinding({
    tag: "AWS.Glue.BatchStopJobRun",
    operation: glue.batchStopJobRun,
    actions: ["glue:BatchStopJobRun"],
  }),
);
