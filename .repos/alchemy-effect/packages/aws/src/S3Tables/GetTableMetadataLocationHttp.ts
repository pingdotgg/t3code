import * as s3tables from "@distilled.cloud/aws/s3tables";
import * as Layer from "effect/Layer";
import { makeS3TablesTableHttpBinding } from "./BindingHttp.ts";
import { GetTableMetadataLocation } from "./GetTableMetadataLocation.ts";

export const GetTableMetadataLocationHttp = Layer.effect(
  GetTableMetadataLocation,
  makeS3TablesTableHttpBinding({
    tag: "AWS.S3Tables.GetTableMetadataLocation",
    operation: s3tables.getTableMetadataLocation,
    actions: ["s3tables:GetTableMetadataLocation"],
  }),
);
