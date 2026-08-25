import * as neptune from "@distilled.cloud/aws/neptune";
import * as Layer from "effect/Layer";
import { makeNeptuneClusterHttpBinding } from "./BindingHttp.ts";
import { FailoverDBCluster } from "./FailoverDBCluster.ts";

export const FailoverDBClusterHttp = Layer.effect(
  FailoverDBCluster,
  makeNeptuneClusterHttpBinding({
    tag: "AWS.Neptune.FailoverDBCluster",
    operation: neptune.failoverDBCluster,
    actions: ["rds:FailoverDBCluster"],
  }),
);
