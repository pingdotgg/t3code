import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import { ListPodIdentityAssociations } from "./ListPodIdentityAssociations.ts";

export const ListPodIdentityAssociationsHttp = Layer.effect(
  ListPodIdentityAssociations,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.ListPodIdentityAssociations",
    operation: eks.listPodIdentityAssociations,
    actions: ["eks:ListPodIdentityAssociations"],
    key: "clusterName",
    scope: "cluster",
  }),
);
