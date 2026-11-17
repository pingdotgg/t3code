import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { makeGlueTableHttpBinding } from "./BindingHttp.ts";
import { GetPartition } from "./GetPartition.ts";

export const GetPartitionHttp = Layer.effect(
  GetPartition,
  makeGlueTableHttpBinding({
    tag: "AWS.Glue.GetPartition",
    operation: glue.getPartition,
    actions: ["glue:GetPartition"],
    tableNameKey: "TableName",
  }),
);
