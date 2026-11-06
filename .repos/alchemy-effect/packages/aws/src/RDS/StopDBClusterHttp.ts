import * as rds from "@distilled.cloud/aws/rds";
import * as Layer from "effect/Layer";
import { makeRdsClusterHttpBinding } from "./BindingHttp.ts";
import { StopDBCluster } from "./StopDBCluster.ts";

export const StopDBClusterHttp = Layer.effect(
  StopDBCluster,
  makeRdsClusterHttpBinding({
    tag: "AWS.RDS.StopDBCluster",
    operation: rds.stopDBCluster,
    actions: ["rds:StopDBCluster"],
  }),
);
