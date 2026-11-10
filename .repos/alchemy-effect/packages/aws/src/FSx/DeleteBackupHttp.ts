import * as fsx from "@distilled.cloud/aws/fsx";
import * as Layer from "effect/Layer";
import { makeFSxAccountHttpBinding } from "./BindingHttp.ts";
import { DeleteBackup } from "./DeleteBackup.ts";

export const DeleteBackupHttp = Layer.effect(
  DeleteBackup,
  makeFSxAccountHttpBinding({
    tag: "AWS.FSx.DeleteBackup",
    operation: fsx.deleteBackup,
    actions: ["fsx:DeleteBackup"],
  }),
);
