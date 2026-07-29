import * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import * as Layer from "effect/Layer";
import { makeCloudHsmHttpBinding } from "./BindingHttp.ts";
import { GetResourcePolicy } from "./GetResourcePolicy.ts";

export const GetResourcePolicyHttp = Layer.effect(
  GetResourcePolicy,
  makeCloudHsmHttpBinding({
    tag: "AWS.CloudHSMV2.GetResourcePolicy",
    operation: cloudhsm.getResourcePolicy,
    actions: ["cloudhsm:GetResourcePolicy"],
  }),
);
