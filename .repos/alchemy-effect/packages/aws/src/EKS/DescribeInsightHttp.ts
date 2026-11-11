import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import { DescribeInsight } from "./DescribeInsight.ts";

export const DescribeInsightHttp = Layer.effect(
  DescribeInsight,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.DescribeInsight",
    operation: eks.describeInsight,
    actions: ["eks:DescribeInsight"],
    key: "clusterName",
    scope: "cluster",
  }),
);
