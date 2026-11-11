import * as AWS from "@alchemy.run/aws";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Orchestrator from "./orchestrator.ts";
import SandboxLive from "./sandbox.ts";

/**
 * Effectful MicroVM stack (AWS-only): deploys the bundled {@link SandboxLive}
 * image plus the {@link Orchestrator} Lambda (uses its execution role) that
 * drives its MicroVM instance operations. The cross-cloud Cloudflare Worker
 * host lives in its own stack (`./cloudflare-stack.ts`) so this one needs no
 * Cloudflare credentials.
 */
export default Alchemy.Stack(
  "MicrovmEffectfulStack",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const fn = yield* Orchestrator;
    return {
      url: fn.functionUrl.as<string>(),
    };
  }).pipe(Effect.provide(SandboxLive)),
);
