import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import { DescribeIdentityProviderConfig } from "./DescribeIdentityProviderConfig.ts";

export const DescribeIdentityProviderConfigHttp = Layer.effect(
  DescribeIdentityProviderConfig,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.DescribeIdentityProviderConfig",
    operation: eks.describeIdentityProviderConfig,
    actions: ["eks:DescribeIdentityProviderConfig"],
    key: "clusterName",
    scope: "subresources",
  }),
);
