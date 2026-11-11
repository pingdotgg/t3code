import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { BatchUpdatePartition } from "./BatchUpdatePartition.ts";
import { makeGlueTableHttpBinding } from "./BindingHttp.ts";

export const BatchUpdatePartitionHttp = Layer.effect(
  BatchUpdatePartition,
  makeGlueTableHttpBinding({
    tag: "AWS.Glue.BatchUpdatePartition",
    operation: glue.batchUpdatePartition,
    actions: ["glue:BatchUpdatePartition", "glue:UpdatePartition"],
    tableNameKey: "TableName",
  }),
);
