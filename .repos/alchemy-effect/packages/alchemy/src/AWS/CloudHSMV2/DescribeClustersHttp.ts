import * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import * as Layer from "effect/Layer";
import { makeCloudHsmHttpBinding } from "./BindingHttp.ts";
import { DescribeClusters } from "./DescribeClusters.ts";

export const DescribeClustersHttp = Layer.effect(
  DescribeClusters,
  makeCloudHsmHttpBinding({
    tag: "AWS.CloudHSMV2.DescribeClusters",
    operation: cloudhsm.describeClusters,
    actions: ["cloudhsm:DescribeClusters"],
  }),
);
