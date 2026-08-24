import * as backup from "@distilled.cloud/aws/backup";
import * as Layer from "effect/Layer";
import { makeBackupAccountHttpBinding } from "./BindingHttp.ts";
import { ListRecoveryPointsByResource } from "./ListRecoveryPointsByResource.ts";

export const ListRecoveryPointsByResourceHttp = Layer.effect(
  ListRecoveryPointsByResource,
  makeBackupAccountHttpBinding({
    tag: "AWS.Backup.ListRecoveryPointsByResource",
    operation: backup.listRecoveryPointsByResource,
    actions: ["backup:ListRecoveryPointsByResource"],
  }),
);
