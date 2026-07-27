import * as memorydb from "@distilled.cloud/aws/memorydb";
import * as Layer from "effect/Layer";
import { makeMemoryDBAccountHttpBinding } from "./BindingHttp.ts";
import { BatchUpdateCluster } from "./BatchUpdateCluster.ts";

export const BatchUpdateClusterHttp = Layer.effect(
  BatchUpdateCluster,
  makeMemoryDBAccountHttpBinding({
    tag: "AWS.MemoryDB.BatchUpdateCluster",
    operation: memorydb.batchUpdateCluster,
    // Clusters are addressed by a runtime name list — grant on the cluster
    // ARN wildcard.
    actions: ["memorydb:BatchUpdateCluster"],
    resources: ["arn:aws:memorydb:*:*:cluster/*"],
  }),
);
