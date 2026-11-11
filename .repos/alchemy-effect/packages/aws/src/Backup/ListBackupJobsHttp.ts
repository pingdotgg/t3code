import * as backup from "@distilled.cloud/aws/backup";
import * as Layer from "effect/Layer";
import { makeBackupAccountHttpBinding } from "./BindingHttp.ts";
import { ListBackupJobs } from "./ListBackupJobs.ts";

export const ListBackupJobsHttp = Layer.effect(
  ListBackupJobs,
  makeBackupAccountHttpBinding({
    tag: "AWS.Backup.ListBackupJobs",
    operation: backup.listBackupJobs,
    actions: ["backup:ListBackupJobs"],
  }),
);
