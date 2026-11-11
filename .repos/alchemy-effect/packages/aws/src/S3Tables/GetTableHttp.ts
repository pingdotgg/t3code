import * as s3tables from "@distilled.cloud/aws/s3tables";
import * as Layer from "effect/Layer";
import { makeS3TablesTableHttpBinding } from "./BindingHttp.ts";
import { GetTable } from "./GetTable.ts";

export const GetTableHttp = Layer.effect(
  GetTable,
  makeS3TablesTableHttpBinding({
    tag: "AWS.S3Tables.GetTable",
    operation: s3tables.getTable,
    actions: ["s3tables:GetTable"],
  }),
);
