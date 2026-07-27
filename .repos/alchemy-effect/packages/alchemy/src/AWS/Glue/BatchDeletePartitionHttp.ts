import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { makeGlueTableHttpBinding } from "./BindingHttp.ts";
import { BatchDeletePartition } from "./BatchDeletePartition.ts";

export const BatchDeletePartitionHttp = Layer.effect(
  BatchDeletePartition,
  makeGlueTableHttpBinding({
    tag: "AWS.Glue.BatchDeletePartition",
    operation: glue.batchDeletePartition,
    actions: ["glue:BatchDeletePartition", "glue:DeletePartition"],
    tableNameKey: "TableName",
  }),
);
