import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import { DescribeCapability } from "./DescribeCapability.ts";

export const DescribeCapabilityHttp = Layer.effect(
  DescribeCapability,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.DescribeCapability",
    operation: eks.describeCapability,
    actions: ["eks:DescribeCapability"],
    key: "clusterName",
    scope: "subresources",
  }),
);
