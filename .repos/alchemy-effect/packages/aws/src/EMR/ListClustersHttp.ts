import * as emr from "@distilled.cloud/aws/emr";
import * as Layer from "effect/Layer";
import { makeEmrAccountHttpBinding } from "./BindingHttp.ts";
import { ListClusters } from "./ListClusters.ts";

export const ListClustersHttp = Layer.effect(
  ListClusters,
  makeEmrAccountHttpBinding({
    tag: "AWS.EMR.ListClusters",
    operation: emr.listClusters,
    actions: ["elasticmapreduce:ListClusters"],
  }),
);
