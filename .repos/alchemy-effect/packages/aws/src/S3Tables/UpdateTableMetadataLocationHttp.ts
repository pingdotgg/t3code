import * as s3tables from "@distilled.cloud/aws/s3tables";
import * as Layer from "effect/Layer";
import { makeS3TablesTableHttpBinding } from "./BindingHttp.ts";
import { UpdateTableMetadataLocation } from "./UpdateTableMetadataLocation.ts";

export const UpdateTableMetadataLocationHttp = Layer.effect(
  UpdateTableMetadataLocation,
  makeS3TablesTableHttpBinding({
    tag: "AWS.S3Tables.UpdateTableMetadataLocation",
    operation: s3tables.updateTableMetadataLocation,
    actions: ["s3tables:UpdateTableMetadataLocation"],
  }),
);
