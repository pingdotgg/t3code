import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import { ListAccessEntries } from "./ListAccessEntries.ts";

export const ListAccessEntriesHttp = Layer.effect(
  ListAccessEntries,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.ListAccessEntries",
    operation: eks.listAccessEntries,
    actions: ["eks:ListAccessEntries"],
    key: "clusterName",
    scope: "cluster",
  }),
);
