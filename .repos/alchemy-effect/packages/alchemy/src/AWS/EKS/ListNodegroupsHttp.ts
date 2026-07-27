import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import { ListNodegroups } from "./ListNodegroups.ts";

export const ListNodegroupsHttp = Layer.effect(
  ListNodegroups,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.ListNodegroups",
    operation: eks.listNodegroups,
    actions: ["eks:ListNodegroups"],
    key: "clusterName",
    scope: "cluster",
  }),
);
