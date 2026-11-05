import * as docdb from "@distilled.cloud/aws/docdb";
import * as Layer from "effect/Layer";
import { makeDocDBClusterHttpBinding } from "./BindingHttp.ts";
import { FailoverDBCluster } from "./FailoverDBCluster.ts";

export const FailoverDBClusterHttp = Layer.effect(
  FailoverDBCluster,
  makeDocDBClusterHttpBinding({
    tag: "AWS.DocDB.FailoverDBCluster",
    operation: docdb.failoverDBCluster,
    actions: ["rds:FailoverDBCluster"],
  }),
);
