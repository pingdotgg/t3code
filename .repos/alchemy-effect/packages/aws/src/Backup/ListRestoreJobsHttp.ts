import * as backup from "@distilled.cloud/aws/backup";
import * as Layer from "effect/Layer";
import { makeBackupAccountHttpBinding } from "./BindingHttp.ts";
import { ListRestoreJobs } from "./ListRestoreJobs.ts";

export const ListRestoreJobsHttp = Layer.effect(
  ListRestoreJobs,
  makeBackupAccountHttpBinding({
    tag: "AWS.Backup.ListRestoreJobs",
    operation: backup.listRestoreJobs,
    actions: ["backup:ListRestoreJobs"],
  }),
);
