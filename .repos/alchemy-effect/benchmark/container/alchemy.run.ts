import * as AWS from "alchemy/AWS";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import BunMicrovmLive from "./src/bun-image.ts";
import ContainerWorker from "./src/container-worker.ts";
import EffectfulBunLive from "./src/effectful-bun.ts";
import EffectfulContainerLive from "./src/effectful-container.ts";
import EffectfulNodeLive from "./src/effectful-node.ts";
import ExternalMicrovmLive from "./src/external-image.ts";
import MicrovmWorker from "./src/microvm-worker.ts";
import NodeMicrovmLive from "./src/node-image.ts";
import OpencodeMicrovmLive from "./src/opencode-image.ts";
import Orchestrator from "./src/orchestrator.ts";

/**
 * MicroVM is a gated AWS Lambda preview. The container benchmark runs against
 * Cloudflare alone; set `BENCH_MICROVM=1` (on an onboarded account) to also
 * deploy the two MicroVM images and the Lambda + Worker hosts that boot them.
 */
export const benchMicrovm = !!process.env.BENCH_MICROVM;

/**
 * Combined cold-start benchmark stack.
 *
 * - Cloudflare: a {@link ContainerWorker} fronting three container variants
 *   (effectful bundled-Effect image, bun-baseline Dockerfile, remote pre-built
 *   image), each behind its own Durable Object.
 * - AWS (optional, `BENCH_MICROVM=1`): six MicroVM images (effectful Effect
 *   bundle on bun + node, raw bun + node baselines, an external Python
 *   Dockerfile, and an eagerly-started opencode server) booted by both a
 *   Lambda {@link Orchestrator} and a cross-cloud Cloudflare
 *   {@link MicrovmWorker}.
 *
 * Exposes each host's URL so the driver can fire boot/shutdown loads and record
 * the time-to-usable-service for every variant.
 */
export default Alchemy.Stack(
  "ContainerBenchmark",
  {
    providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const containerWorker = yield* ContainerWorker;

    if (!benchMicrovm) {
      return { containerWorkerUrl: containerWorker.url.as<string>() };
    }

    const orchestrator = yield* Orchestrator;
    const microvmWorker = yield* MicrovmWorker;
    return {
      containerWorkerUrl: containerWorker.url.as<string>(),
      lambdaUrl: orchestrator.functionUrl.as<string>(),
      microvmWorkerUrl: microvmWorker.url.as<string>(),
    };
  }).pipe(
    Effect.provide(
      benchMicrovm
        ? Layer.mergeAll(
            EffectfulContainerLive,
            EffectfulBunLive,
            EffectfulNodeLive,
            BunMicrovmLive,
            NodeMicrovmLive,
            ExternalMicrovmLive,
            OpencodeMicrovmLive,
          )
        : EffectfulContainerLive,
    ),
  ),
);
