import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import { DescribeUpdate } from "./DescribeUpdate.ts";

export const DescribeUpdateHttp = Layer.effect(
  DescribeUpdate,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.DescribeUpdate",
    operation: eks.describeUpdate,
    actions: ["eks:DescribeUpdate"],
    key: "name",
    scope: "both",
  }),
);
