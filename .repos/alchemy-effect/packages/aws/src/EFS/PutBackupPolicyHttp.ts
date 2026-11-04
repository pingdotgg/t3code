import * as efs from "@distilled.cloud/aws/efs";
import * as Layer from "effect/Layer";
import { makeEfsFileSystemHttpBinding } from "./BindingHttp.ts";
import { PutBackupPolicy } from "./PutBackupPolicy.ts";

export const PutBackupPolicyHttp = Layer.effect(
  PutBackupPolicy,
  makeEfsFileSystemHttpBinding({
    tag: "AWS.EFS.PutBackupPolicy",
    operation: efs.putBackupPolicy,
    actions: ["elasticfilesystem:PutBackupPolicy"],
  }),
);
