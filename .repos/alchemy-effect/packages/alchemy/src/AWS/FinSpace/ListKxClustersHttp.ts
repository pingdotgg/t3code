import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { ListKxClusters } from "./ListKxClusters.ts";

export const ListKxClustersHttp = Layer.effect(
  ListKxClusters,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.ListKxClusters",
    operation: finspace.listKxClusters,
    actions: ["finspace:ListKxClusters"],
  }),
);
