import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import { ListUpdates } from "./ListUpdates.ts";

export const ListUpdatesHttp = Layer.effect(
  ListUpdates,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.ListUpdates",
    operation: eks.listUpdates,
    actions: ["eks:ListUpdates"],
    key: "name",
    scope: "both",
  }),
);
