import * as Kubernetes from "@/Kubernetes";
import * as Effect from "effect/Effect";
import { TestLocalCluster } from "./local.ts";

/**
 * An Effect program run as a one-shot Job on the local cluster: bundled,
 * built for the node architecture, pushed to the cluster's registry, and
 * pulled by the node.
 */
export default Kubernetes.Job(
  "LocalEffectJob",
  Effect.gen(function* () {
    const cluster = yield* TestLocalCluster;
    return {
      cluster,
      main: import.meta.url,
      name: "local-effect-job",
      backoffLimit: 1,
    };
  }),
  Effect.gen(function* () {
    return {
      run: Effect.log("local effect job ran"),
    };
  }),
);
