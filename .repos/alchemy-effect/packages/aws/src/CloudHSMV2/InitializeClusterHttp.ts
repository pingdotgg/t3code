import * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import * as Layer from "effect/Layer";
import { makeCloudHsmHttpBinding } from "./BindingHttp.ts";
import { InitializeCluster } from "./InitializeCluster.ts";

export const InitializeClusterHttp = Layer.effect(
  InitializeCluster,
  makeCloudHsmHttpBinding({
    tag: "AWS.CloudHSMV2.InitializeCluster",
    operation: cloudhsm.initializeCluster,
    actions: ["cloudhsm:InitializeCluster"],
  }),
);
