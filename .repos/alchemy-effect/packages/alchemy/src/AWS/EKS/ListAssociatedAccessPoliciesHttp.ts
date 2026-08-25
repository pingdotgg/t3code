import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import { ListAssociatedAccessPolicies } from "./ListAssociatedAccessPolicies.ts";

export const ListAssociatedAccessPoliciesHttp = Layer.effect(
  ListAssociatedAccessPolicies,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.ListAssociatedAccessPolicies",
    operation: eks.listAssociatedAccessPolicies,
    actions: ["eks:ListAssociatedAccessPolicies"],
    key: "clusterName",
    scope: "subresources",
  }),
);
