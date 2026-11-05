import * as rds from "@distilled.cloud/aws/rds";
import * as Layer from "effect/Layer";
import { makeRdsClusterHttpBinding } from "./BindingHttp.ts";
import { FailoverDBCluster } from "./FailoverDBCluster.ts";

export const FailoverDBClusterHttp = Layer.effect(
  FailoverDBCluster,
  makeRdsClusterHttpBinding({
    tag: "AWS.RDS.FailoverDBCluster",
    operation: rds.failoverDBCluster,
    actions: ["rds:FailoverDBCluster"],
  }),
);
