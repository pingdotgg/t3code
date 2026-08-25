import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import { DescribePodIdentityAssociation } from "./DescribePodIdentityAssociation.ts";

export const DescribePodIdentityAssociationHttp = Layer.effect(
  DescribePodIdentityAssociation,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.DescribePodIdentityAssociation",
    operation: eks.describePodIdentityAssociation,
    actions: ["eks:DescribePodIdentityAssociation"],
    key: "clusterName",
    scope: "subresources",
  }),
);
