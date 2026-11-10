import * as rds from "@distilled.cloud/aws/rds";
import * as Layer from "effect/Layer";
import { makeRdsClusterHttpBinding } from "./BindingHttp.ts";
import { StartDBCluster } from "./StartDBCluster.ts";

export const StartDBClusterHttp = Layer.effect(
  StartDBCluster,
  makeRdsClusterHttpBinding({
    tag: "AWS.RDS.StartDBCluster",
    operation: rds.startDBCluster,
    actions: ["rds:StartDBCluster"],
  }),
);
