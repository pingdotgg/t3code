import * as backup from "@distilled.cloud/aws/backup";
import * as Layer from "effect/Layer";
import { makeBackupAccountHttpBinding } from "./BindingHttp.ts";
import { ListCopyJobs } from "./ListCopyJobs.ts";

export const ListCopyJobsHttp = Layer.effect(
  ListCopyJobs,
  makeBackupAccountHttpBinding({
    tag: "AWS.Backup.ListCopyJobs",
    operation: backup.listCopyJobs,
    actions: ["backup:ListCopyJobs"],
  }),
);
