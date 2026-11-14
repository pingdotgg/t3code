import * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import * as Layer from "effect/Layer";
import { makeCloudHsmHttpBinding } from "./BindingHttp.ts";
import { DeleteResourcePolicy } from "./DeleteResourcePolicy.ts";

export const DeleteResourcePolicyHttp = Layer.effect(
  DeleteResourcePolicy,
  makeCloudHsmHttpBinding({
    tag: "AWS.CloudHSMV2.DeleteResourcePolicy",
    operation: cloudhsm.deleteResourcePolicy,
    actions: ["cloudhsm:DeleteResourcePolicy"],
  }),
);
