import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { makeGlueTableHttpBinding } from "./BindingHttp.ts";
import { UpdatePartition } from "./UpdatePartition.ts";

export const UpdatePartitionHttp = Layer.effect(
  UpdatePartition,
  makeGlueTableHttpBinding({
    tag: "AWS.Glue.UpdatePartition",
    operation: glue.updatePartition,
    actions: ["glue:UpdatePartition"],
    tableNameKey: "TableName",
  }),
);
