import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { makeGlueTableHttpBinding } from "./BindingHttp.ts";
import { BatchGetPartition } from "./BatchGetPartition.ts";

export const BatchGetPartitionHttp = Layer.effect(
  BatchGetPartition,
  makeGlueTableHttpBinding({
    tag: "AWS.Glue.BatchGetPartition",
    operation: glue.batchGetPartition,
    actions: ["glue:BatchGetPartition", "glue:GetPartition"],
    tableNameKey: "TableName",
  }),
);
