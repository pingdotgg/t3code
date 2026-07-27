import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import { MicrovmBuildRole } from "./build-role.ts";

/**
 * Bun baseline MicroVM image — the dumbest possible `Bun.serve` HTTP server,
 * built from `contexts/microvm-bun/` the same way alchemy builds the effectful
 * {@link import("./effectful-bun.ts").EffectfulBun} image (same MicroVM base, same bun install, same ARM_64 arch,
 * same 512 MiB). The only difference is the absence of the Effect runtime and
 * the alchemy bootstrap, so `effectful.readyMs − bun.readyMs` isolates the
 * cold-start cost of alchemy's Effect abstraction with the runtime and CPU
 * architecture held constant.
 */
export class BunMicrovm extends AWS.Lambda.MicrovmImage<BunMicrovm>()(
  "MicrovmBenchBun",
) {}

export default BunMicrovm.make(
  MicrovmBuildRole.pipe(
    Effect.map((buildRole) => ({
      // External (Dockerfile) mode: the runtime is NOT chosen by alchemy's
      // `runtime` prop (that only applies to effectful `main:` images). It is
      // decided entirely by this context's Dockerfile, which installs and runs
      // bun. Match the effectful EffectfulBun's image config: ARM_64, 512 MiB.
      context: new URL("../contexts/microvm-bun/", import.meta.url).pathname,
      buildRole,
      resources: [{ minimumMemoryInMiB: 512 }],
      cpuConfigurations: [{ architecture: "ARM_64" }],
    })),
  ),
  // External (Dockerfile) mode — no Effect runtime to bundle.
  Effect.succeed({}),
);
