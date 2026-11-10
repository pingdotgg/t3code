import * as docdb from "@distilled.cloud/aws/docdb";
import * as Layer from "effect/Layer";
import { makeDocDBClusterHttpBinding } from "./BindingHttp.ts";
import { StopDBCluster } from "./StopDBCluster.ts";

export const StopDBClusterHttp = Layer.effect(
  StopDBCluster,
  makeDocDBClusterHttpBinding({
    tag: "AWS.DocDB.StopDBCluster",
    operation: docdb.stopDBCluster,
    actions: ["rds:StopDBCluster"],
  }),
);
