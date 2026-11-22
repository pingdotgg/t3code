import * as neptune from "@distilled.cloud/aws/neptune";
import * as Layer from "effect/Layer";
import { makeNeptuneClusterHttpBinding } from "./BindingHttp.ts";
import { StopDBCluster } from "./StopDBCluster.ts";

export const StopDBClusterHttp = Layer.effect(
  StopDBCluster,
  makeNeptuneClusterHttpBinding({
    tag: "AWS.Neptune.StopDBCluster",
    operation: neptune.stopDBCluster,
    actions: ["rds:StopDBCluster"],
  }),
);
