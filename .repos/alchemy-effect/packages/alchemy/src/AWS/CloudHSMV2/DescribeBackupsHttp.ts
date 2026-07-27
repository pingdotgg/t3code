import * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import * as Layer from "effect/Layer";
import { makeCloudHsmHttpBinding } from "./BindingHttp.ts";
import { DescribeBackups } from "./DescribeBackups.ts";

export const DescribeBackupsHttp = Layer.effect(
  DescribeBackups,
  makeCloudHsmHttpBinding({
    tag: "AWS.CloudHSMV2.DescribeBackups",
    operation: cloudhsm.describeBackups,
    actions: ["cloudhsm:DescribeBackups"],
  }),
);
