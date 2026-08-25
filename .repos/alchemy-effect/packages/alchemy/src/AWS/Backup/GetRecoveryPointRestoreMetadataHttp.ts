import * as backup from "@distilled.cloud/aws/backup";
import * as Layer from "effect/Layer";
import { makeBackupVaultHttpBinding } from "./BindingHttp.ts";
import { GetRecoveryPointRestoreMetadata } from "./GetRecoveryPointRestoreMetadata.ts";

export const GetRecoveryPointRestoreMetadataHttp = Layer.effect(
  GetRecoveryPointRestoreMetadata,
  makeBackupVaultHttpBinding({
    tag: "AWS.Backup.GetRecoveryPointRestoreMetadata",
    operation: backup.getRecoveryPointRestoreMetadata,
    actions: ["backup:GetRecoveryPointRestoreMetadata"],
    // Recovery-point actions authorize on the recovery point ARN (the
    // underlying resource's snapshot ARN), not the vault ARN.
    wildcardIam: true,
  }),
);
