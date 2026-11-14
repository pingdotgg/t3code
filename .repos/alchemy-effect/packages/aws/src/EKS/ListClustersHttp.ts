import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSAccountHttpBinding } from "./BindingHttp.ts";
import { ListClusters } from "./ListClusters.ts";

export const ListClustersHttp = Layer.effect(
  ListClusters,
  makeEKSAccountHttpBinding({
    tag: "AWS.EKS.ListClusters",
    operation: eks.listClusters,
    actions: ["eks:ListClusters"],
  }),
);
