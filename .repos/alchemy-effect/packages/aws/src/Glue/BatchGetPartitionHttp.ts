import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { BatchGetPartition } from "./BatchGetPartition.ts";
import { makeGlueTableHttpBinding } from "./BindingHttp.ts";

export const BatchGetPartitionHttp = Layer.effect(
  BatchGetPartition,
  makeGlueTableHttpBinding({
    tag: "AWS.Glue.BatchGetPartition",
    operation: glue.batchGetPartition,
    actions: ["glue:BatchGetPartition", "glue:GetPartition"],
    tableNameKey: "TableName",
  }),
);
