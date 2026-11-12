import * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import * as Layer from "effect/Layer";
import { makeCloudHsmHttpBinding } from "./BindingHttp.ts";
import { RestoreBackup } from "./RestoreBackup.ts";

export const RestoreBackupHttp = Layer.effect(
  RestoreBackup,
  makeCloudHsmHttpBinding({
    tag: "AWS.CloudHSMV2.RestoreBackup",
    operation: cloudhsm.restoreBackup,
    actions: ["cloudhsm:RestoreBackup"],
  }),
);
