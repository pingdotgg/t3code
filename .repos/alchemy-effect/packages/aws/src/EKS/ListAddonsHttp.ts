import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import { ListAddons } from "./ListAddons.ts";

export const ListAddonsHttp = Layer.effect(
  ListAddons,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.ListAddons",
    operation: eks.listAddons,
    actions: ["eks:ListAddons"],
    key: "clusterName",
    scope: "cluster",
  }),
);
