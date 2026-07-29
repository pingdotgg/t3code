import * as fsx from "@distilled.cloud/aws/fsx";
import * as Layer from "effect/Layer";
import { makeFSxAccountHttpBinding } from "./BindingHttp.ts";
import { CopyBackup } from "./CopyBackup.ts";

export const CopyBackupHttp = Layer.effect(
  CopyBackup,
  makeFSxAccountHttpBinding({
    tag: "AWS.FSx.CopyBackup",
    // CopyBackup tags the new backup it creates, so it needs TagResource
    // alongside the copy itself.
    operation: fsx.copyBackup,
    actions: ["fsx:CopyBackup", "fsx:TagResource"],
  }),
);
