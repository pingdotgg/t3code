import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import { DescribeCluster } from "./DescribeCluster.ts";

export const DescribeClusterHttp = Layer.effect(
  DescribeCluster,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.DescribeCluster",
    operation: eks.describeCluster,
    actions: ["eks:DescribeCluster"],
    key: "name",
    scope: "cluster",
  }),
);
