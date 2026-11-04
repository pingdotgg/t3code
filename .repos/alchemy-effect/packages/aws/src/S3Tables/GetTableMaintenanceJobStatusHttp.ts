import * as s3tables from "@distilled.cloud/aws/s3tables";
import * as Layer from "effect/Layer";
import { makeS3TablesTableHttpBinding } from "./BindingHttp.ts";
import { GetTableMaintenanceJobStatus } from "./GetTableMaintenanceJobStatus.ts";

export const GetTableMaintenanceJobStatusHttp = Layer.effect(
  GetTableMaintenanceJobStatus,
  makeS3TablesTableHttpBinding({
    tag: "AWS.S3Tables.GetTableMaintenanceJobStatus",
    operation: s3tables.getTableMaintenanceJobStatus,
    actions: ["s3tables:GetTableMaintenanceJobStatus"],
  }),
);
