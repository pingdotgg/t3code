import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { DeleteKxClusterNode } from "./DeleteKxClusterNode.ts";

export const DeleteKxClusterNodeHttp = Layer.effect(
  DeleteKxClusterNode,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.DeleteKxClusterNode",
    operation: finspace.deleteKxClusterNode,
    actions: ["finspace:DeleteKxClusterNode"],
  }),
);
