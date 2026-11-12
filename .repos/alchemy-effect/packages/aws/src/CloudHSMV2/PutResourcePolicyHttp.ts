import * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import * as Layer from "effect/Layer";
import { makeCloudHsmHttpBinding } from "./BindingHttp.ts";
import { PutResourcePolicy } from "./PutResourcePolicy.ts";

export const PutResourcePolicyHttp = Layer.effect(
  PutResourcePolicy,
  makeCloudHsmHttpBinding({
    tag: "AWS.CloudHSMV2.PutResourcePolicy",
    operation: cloudhsm.putResourcePolicy,
    actions: ["cloudhsm:PutResourcePolicy"],
  }),
);
