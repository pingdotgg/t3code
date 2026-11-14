import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { BatchCreatePartition } from "./BatchCreatePartition.ts";
import { makeGlueTableHttpBinding } from "./BindingHttp.ts";

export const BatchCreatePartitionHttp = Layer.effect(
  BatchCreatePartition,
  makeGlueTableHttpBinding({
    tag: "AWS.Glue.BatchCreatePartition",
    operation: glue.batchCreatePartition,
    actions: ["glue:BatchCreatePartition"],
    tableNameKey: "TableName",
  }),
);
