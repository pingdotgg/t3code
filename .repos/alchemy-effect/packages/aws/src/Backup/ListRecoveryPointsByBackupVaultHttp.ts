import * as backup from "@distilled.cloud/aws/backup";
import * as Layer from "effect/Layer";
import { makeBackupVaultHttpBinding } from "./BindingHttp.ts";
import { ListRecoveryPointsByBackupVault } from "./ListRecoveryPointsByBackupVault.ts";

export const ListRecoveryPointsByBackupVaultHttp = Layer.effect(
  ListRecoveryPointsByBackupVault,
  makeBackupVaultHttpBinding({
    tag: "AWS.Backup.ListRecoveryPointsByBackupVault",
    operation: backup.listRecoveryPointsByBackupVault,
    actions: ["backup:ListRecoveryPointsByBackupVault"],
  }),
);
