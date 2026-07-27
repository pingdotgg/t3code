import * as AWS from "@/AWS";
import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Orchestrator from "./orchestrator.ts";
import SandboxLive from "./sandbox.ts";
import MicrovmWorker from "./worker.ts";

/**
 * Effectful MicroVM stack: deploys the bundled {@link SandboxLive} image plus
 * two orchestrators that drive its MicroVM instance operations —
 *
 *  - {@link Orchestrator}: an AWS Lambda (uses its execution role).
 *  - {@link MicrovmWorker}: a Cloudflare Worker (cross-cloud — Alchemy mints an
 *    IAM User + AccessKey + assume-role Role and the worker assumes it).
 *
 * Needs BOTH provider sets. Exposes each orchestrator's URL so the test can
 * drive the lifecycle over HTTP against either host.
 */
export default Alchemy.Stack(
  "MicrovmEffectfulStack",
  {
    providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const fn = yield* Orchestrator;
    const worker = yield* MicrovmWorker;
    return {
      url: fn.functionUrl.as<string>(),
      workerUrl: worker.url.as<string>(),
    };
  }).pipe(Effect.provide(SandboxLive)),
);
