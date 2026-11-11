import * as emrc from "@distilled.cloud/aws/emr-containers";
import * as Layer from "effect/Layer";
import { makeEMRContainersAccountHttpBinding } from "./BindingHttp.ts";
import { ListVirtualClusters } from "./ListVirtualClusters.ts";

export const ListVirtualClustersHttp = Layer.effect(
  ListVirtualClusters,
  makeEMRContainersAccountHttpBinding({
    tag: "AWS.EMRContainers.ListVirtualClusters",
    operation: emrc.listVirtualClusters,
    actions: ["emr-containers:ListVirtualClusters"],
  }),
);
