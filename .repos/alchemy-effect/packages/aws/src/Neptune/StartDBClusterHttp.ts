import * as neptune from "@distilled.cloud/aws/neptune";
import * as Layer from "effect/Layer";
import { makeNeptuneClusterHttpBinding } from "./BindingHttp.ts";
import { StartDBCluster } from "./StartDBCluster.ts";

export const StartDBClusterHttp = Layer.effect(
  StartDBCluster,
  makeNeptuneClusterHttpBinding({
    tag: "AWS.Neptune.StartDBCluster",
    operation: neptune.startDBCluster,
    actions: ["rds:StartDBCluster"],
  }),
);
