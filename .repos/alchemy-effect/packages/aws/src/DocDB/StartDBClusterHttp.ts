import * as docdb from "@distilled.cloud/aws/docdb";
import * as Layer from "effect/Layer";
import { makeDocDBClusterHttpBinding } from "./BindingHttp.ts";
import { StartDBCluster } from "./StartDBCluster.ts";

export const StartDBClusterHttp = Layer.effect(
  StartDBCluster,
  makeDocDBClusterHttpBinding({
    tag: "AWS.DocDB.StartDBCluster",
    operation: docdb.startDBCluster,
    actions: ["rds:StartDBCluster"],
  }),
);
