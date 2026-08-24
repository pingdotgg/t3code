import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import { DescribeAccessEntry } from "./DescribeAccessEntry.ts";

export const DescribeAccessEntryHttp = Layer.effect(
  DescribeAccessEntry,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.DescribeAccessEntry",
    operation: eks.describeAccessEntry,
    actions: ["eks:DescribeAccessEntry"],
    key: "clusterName",
    scope: "subresources",
  }),
);
