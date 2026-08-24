import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import { MicrovmBuildRole } from "./build-role.ts";
import { effectfulImpl } from "./effectful-impl.ts";

/**
 * Effectful MicroVM image on **bun** — a bundled Effect program exposing a raw
 * `fetch` handler and a typed RPC `hello` method. Pairs with the bun baseline
 * ({@link import("./bun-image.ts")}): same runtime + ARM_64 arch, the only
 * difference being the bundled Effect runtime / alchemy bootstrap. Compare to
 * {@link import("./effectful-node.ts").EffectfulNode} for the node-vs-bun delta.
 */
export class EffectfulBun extends AWS.Lambda.MicrovmImage<
  EffectfulBun,
  {
    hello: (message: string) => Effect.Effect<string>;
  }
>()("MicrovmEffectfulBun") {}

export default EffectfulBun.make(
  MicrovmBuildRole.pipe(
    Effect.map((buildRole) => ({
      main: import.meta.filename,
      buildRole,
      runtime: "bun" as const,
      resources: [{ minimumMemoryInMiB: 512 }],
      cpuConfigurations: [{ architecture: "ARM_64" }],
    })),
  ),
  effectfulImpl,
);
