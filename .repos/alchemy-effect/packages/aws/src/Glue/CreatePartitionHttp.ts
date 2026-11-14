import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { makeGlueTableHttpBinding } from "./BindingHttp.ts";
import { CreatePartition } from "./CreatePartition.ts";

export const CreatePartitionHttp = Layer.effect(
  CreatePartition,
  makeGlueTableHttpBinding({
    tag: "AWS.Glue.CreatePartition",
    operation: glue.createPartition,
    actions: ["glue:CreatePartition"],
    tableNameKey: "TableName",
  }),
);
