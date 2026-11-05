import * as s3tables from "@distilled.cloud/aws/s3tables";
import * as Layer from "effect/Layer";
import { makeS3TablesTableBucketHttpBinding } from "./BindingHttp.ts";
import { ListTables } from "./ListTables.ts";

export const ListTablesHttp = Layer.effect(
  ListTables,
  makeS3TablesTableBucketHttpBinding({
    tag: "AWS.S3Tables.ListTables",
    operation: s3tables.listTables,
    actions: ["s3tables:ListTables"],
  }),
);
