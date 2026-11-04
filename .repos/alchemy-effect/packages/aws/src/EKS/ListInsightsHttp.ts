import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import { ListInsights } from "./ListInsights.ts";

export const ListInsightsHttp = Layer.effect(
  ListInsights,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.ListInsights",
    operation: eks.listInsights,
    actions: ["eks:ListInsights"],
    key: "clusterName",
    scope: "cluster",
  }),
);
