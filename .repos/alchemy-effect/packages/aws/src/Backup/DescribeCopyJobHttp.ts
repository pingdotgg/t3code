import * as backup from "@distilled.cloud/aws/backup";
import * as Layer from "effect/Layer";
import { makeBackupAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeCopyJob } from "./DescribeCopyJob.ts";

export const DescribeCopyJobHttp = Layer.effect(
  DescribeCopyJob,
  makeBackupAccountHttpBinding({
    tag: "AWS.Backup.DescribeCopyJob",
    operation: backup.describeCopyJob,
    actions: ["backup:DescribeCopyJob"],
  }),
);
