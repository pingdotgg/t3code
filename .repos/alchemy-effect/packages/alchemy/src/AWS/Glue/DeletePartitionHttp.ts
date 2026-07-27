import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { makeGlueTableHttpBinding } from "./BindingHttp.ts";
import { DeletePartition } from "./DeletePartition.ts";

export const DeletePartitionHttp = Layer.effect(
  DeletePartition,
  makeGlueTableHttpBinding({
    tag: "AWS.Glue.DeletePartition",
    operation: glue.deletePartition,
    actions: ["glue:DeletePartition"],
    tableNameKey: "TableName",
  }),
);
