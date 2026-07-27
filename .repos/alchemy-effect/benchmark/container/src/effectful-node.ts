import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import { MicrovmBuildRole } from "./build-role.ts";
import { effectfulImpl } from "./effectful-impl.ts";

/**
 * Effectful MicroVM image on **node** — identical server to the bun effectful
 * {@link import("./effectful-bun.ts").EffectfulBun}, but bundled for the node
 * runtime (`dnf install -y nodejs`, no bun install). Since the Lambda MicroVM
 * base ships node, this avoids the bun installer step entirely; comparing it to
 * the bun effectful isolates the runtime's contribution to cold start.
 */
export class EffectfulNode extends AWS.Lambda.MicrovmImage<
  EffectfulNode,
  {
    hello: (message: string) => Effect.Effect<string>;
  }
>()("MicrovmEffectfulNode") {}

export default EffectfulNode.make(
  MicrovmBuildRole.pipe(
    Effect.map((buildRole) => ({
      main: import.meta.filename,
      buildRole,
      runtime: "node" as const,
      resources: [{ minimumMemoryInMiB: 512 }],
      cpuConfigurations: [{ architecture: "ARM_64" }],
    })),
  ),
  effectfulImpl,
);
