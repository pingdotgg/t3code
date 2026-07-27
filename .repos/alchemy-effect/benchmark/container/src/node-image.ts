import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import { MicrovmBuildRole } from "./build-role.ts";

/**
 * Node baseline MicroVM image — the dumbest possible `http.createServer`
 * server, built from `contexts/microvm-node/` the same way alchemy builds the
 * effectful node {@link import("./effectful-node.ts").EffectfulNode} image (same
 * MicroVM base, same `dnf install -y nodejs`, same ARM_64 arch, same 512 MiB).
 * `effectfulNode.readyMs − node.readyMs` isolates the alchemy/Effect cold-start
 * tax on the runtime the Lambda VMs already ship.
 */
export class NodeMicrovm extends AWS.Lambda.MicrovmImage<NodeMicrovm>()(
  "MicrovmBenchNode",
) {}

export default NodeMicrovm.make(
  MicrovmBuildRole.pipe(
    Effect.map((buildRole) => ({
      // External (Dockerfile) mode: the runtime is decided by this context's
      // Dockerfile (installs + runs node), NOT by alchemy's `runtime` prop —
      // that only applies to effectful `main:` images. Match the effectful
      // EffectfulNode's image config: ARM_64, 512 MiB.
      context: new URL("../contexts/microvm-node/", import.meta.url).pathname,
      buildRole,
      resources: [{ minimumMemoryInMiB: 512 }],
      cpuConfigurations: [{ architecture: "ARM_64" }],
    })),
  ),
  // External (Dockerfile) mode — no Effect runtime to bundle.
  Effect.succeed({}),
);
