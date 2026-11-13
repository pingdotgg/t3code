import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import { DescribeInsightsRefresh } from "./DescribeInsightsRefresh.ts";

export const DescribeInsightsRefreshHttp = Layer.effect(
  DescribeInsightsRefresh,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.DescribeInsightsRefresh",
    operation: eks.describeInsightsRefresh,
    actions: ["eks:DescribeInsightsRefresh"],
    key: "clusterName",
    scope: "cluster",
  }),
);
