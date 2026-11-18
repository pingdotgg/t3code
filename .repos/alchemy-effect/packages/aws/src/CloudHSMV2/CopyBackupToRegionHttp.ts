import * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import * as Layer from "effect/Layer";
import { makeCloudHsmHttpBinding } from "./BindingHttp.ts";
import { CopyBackupToRegion } from "./CopyBackupToRegion.ts";

export const CopyBackupToRegionHttp = Layer.effect(
  CopyBackupToRegion,
  makeCloudHsmHttpBinding({
    tag: "AWS.CloudHSMV2.CopyBackupToRegion",
    operation: cloudhsm.copyBackupToRegion,
    // TagResource lets the copy carry the source backup's user tags into
    // the destination region.
    actions: ["cloudhsm:CopyBackupToRegion", "cloudhsm:TagResource"],
  }),
);
