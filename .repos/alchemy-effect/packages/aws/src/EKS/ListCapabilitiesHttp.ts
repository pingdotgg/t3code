import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import { ListCapabilities } from "./ListCapabilities.ts";

export const ListCapabilitiesHttp = Layer.effect(
  ListCapabilities,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.ListCapabilities",
    operation: eks.listCapabilities,
    actions: ["eks:ListCapabilities"],
    key: "clusterName",
    scope: "cluster",
  }),
);
