import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import { DescribeNodegroup } from "./DescribeNodegroup.ts";

export const DescribeNodegroupHttp = Layer.effect(
  DescribeNodegroup,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.DescribeNodegroup",
    operation: eks.describeNodegroup,
    actions: ["eks:DescribeNodegroup"],
    key: "clusterName",
    scope: "subresources",
  }),
);
