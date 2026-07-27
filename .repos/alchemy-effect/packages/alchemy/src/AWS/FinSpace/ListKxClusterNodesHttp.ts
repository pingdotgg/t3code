import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { ListKxClusterNodes } from "./ListKxClusterNodes.ts";

export const ListKxClusterNodesHttp = Layer.effect(
  ListKxClusterNodes,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.ListKxClusterNodes",
    operation: finspace.listKxClusterNodes,
    actions: ["finspace:ListKxClusterNodes"],
  }),
);
