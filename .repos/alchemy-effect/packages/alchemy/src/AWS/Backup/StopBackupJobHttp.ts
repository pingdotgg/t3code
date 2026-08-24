import * as backup from "@distilled.cloud/aws/backup";
import * as Layer from "effect/Layer";
import { makeBackupAccountHttpBinding } from "./BindingHttp.ts";
import { StopBackupJob } from "./StopBackupJob.ts";

export const StopBackupJobHttp = Layer.effect(
  StopBackupJob,
  makeBackupAccountHttpBinding({
    tag: "AWS.Backup.StopBackupJob",
    operation: backup.stopBackupJob,
    actions: ["backup:StopBackupJob"],
  }),
);
