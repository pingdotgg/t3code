import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { makeGlueTableHttpBinding } from "./BindingHttp.ts";
import { BatchUpdatePartition } from "./BatchUpdatePartition.ts";

export const BatchUpdatePartitionHttp = Layer.effect(
  BatchUpdatePartition,
  makeGlueTableHttpBinding({
    tag: "AWS.Glue.BatchUpdatePartition",
    operation: glue.batchUpdatePartition,
    actions: ["glue:BatchUpdatePartition", "glue:UpdatePartition"],
    tableNameKey: "TableName",
  }),
);
