import * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import * as Layer from "effect/Layer";
import { makeCloudHsmHttpBinding } from "./BindingHttp.ts";
import { ModifyBackupAttributes } from "./ModifyBackupAttributes.ts";

export const ModifyBackupAttributesHttp = Layer.effect(
  ModifyBackupAttributes,
  makeCloudHsmHttpBinding({
    tag: "AWS.CloudHSMV2.ModifyBackupAttributes",
    operation: cloudhsm.modifyBackupAttributes,
    actions: ["cloudhsm:ModifyBackupAttributes"],
  }),
);
