import * as finspace from "@distilled.cloud/aws/finspace";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import { GetKxCluster } from "./GetKxCluster.ts";

export const GetKxClusterHttp = Layer.effect(
  GetKxCluster,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.GetKxCluster",
    operation: finspace.getKxCluster,
    actions: ["finspace:GetKxCluster"],
  }),
);
