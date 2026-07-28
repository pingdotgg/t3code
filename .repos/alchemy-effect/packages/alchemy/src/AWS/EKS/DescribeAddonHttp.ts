import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import { DescribeAddon } from "./DescribeAddon.ts";

export const DescribeAddonHttp = Layer.effect(
  DescribeAddon,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.DescribeAddon",
    operation: eks.describeAddon,
    actions: ["eks:DescribeAddon"],
    key: "clusterName",
    scope: "subresources",
  }),
);
