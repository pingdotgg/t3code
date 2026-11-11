import * as backup from "@distilled.cloud/aws/backup";
import * as Layer from "effect/Layer";
import { makeBackupAccountHttpBinding } from "./BindingHttp.ts";
import { GetRestoreJobMetadata } from "./GetRestoreJobMetadata.ts";

export const GetRestoreJobMetadataHttp = Layer.effect(
  GetRestoreJobMetadata,
  makeBackupAccountHttpBinding({
    tag: "AWS.Backup.GetRestoreJobMetadata",
    operation: backup.getRestoreJobMetadata,
    actions: ["backup:GetRestoreJobMetadata"],
  }),
);
