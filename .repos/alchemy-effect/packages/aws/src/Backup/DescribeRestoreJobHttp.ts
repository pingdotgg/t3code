import * as backup from "@distilled.cloud/aws/backup";
import * as Layer from "effect/Layer";
import { makeBackupAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeRestoreJob } from "./DescribeRestoreJob.ts";

export const DescribeRestoreJobHttp = Layer.effect(
  DescribeRestoreJob,
  makeBackupAccountHttpBinding({
    tag: "AWS.Backup.DescribeRestoreJob",
    operation: backup.describeRestoreJob,
    actions: ["backup:DescribeRestoreJob"],
  }),
);
