import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeClusterVersions } from "./DescribeClusterVersions.ts";

export const DescribeClusterVersionsHttp = Layer.effect(
  DescribeClusterVersions,
  makeEKSAccountHttpBinding({
    tag: "AWS.EKS.DescribeClusterVersions",
    operation: eks.describeClusterVersions,
    actions: ["eks:DescribeClusterVersions"],
  }),
);
