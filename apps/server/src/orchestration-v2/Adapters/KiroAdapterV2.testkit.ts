import * as NodeServices from "@effect/platform-node/NodeServices";
import { KiroSettings, ProviderInstanceId } from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { ProviderReplayGate } from "../testkit/ProviderReplayGate.testkit.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import { makeReplayServerConfig } from "../testkit/ProviderReplayHarness.ts";
import {
  type AcpReplayTranscript,
  AcpReplayTranscriptDecodeError,
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";
import { KIRO_PROVIDER, makeKiroAdapterV2 } from "./KiroAdapterV2.ts";

const KIRO_REPLAY_SETTINGS = Schema.decodeUnknownSync(KiroSettings)({ enabled: true });

function makeKiroProviderAdapterRegistryReplayLayer(
  transcript: AcpReplayTranscript,
  options: { readonly replayGate?: ProviderReplayGate } = {},
) {
  const serverConfigLayer = Layer.effect(
    ServerConfig.ServerConfig,
    makeReplayServerConfig(`kiro-${transcript.scenario}`).pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer));

  return ProviderAdapterRegistry.makeLayerEffect(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const replayDir = yield* fileSystem
        .makeTempDirectory({ prefix: `t3-orchestration-v2-kiro-replay-${transcript.scenario}-` })
        .pipe(Effect.orDie);
      const statusPath = path.join(replayDir, "status.json");
      const scriptPath = yield* path
        .fromFileUrl(new URL("../../../scripts/acp-replay-agent.ts", import.meta.url))
        .pipe(Effect.orDie);
      const adapter = makeKiroAdapterV2({
        instanceId: ProviderInstanceId.make("kiro"),
        settings: KIRO_REPLAY_SETTINGS,
        environment: {},
        childProcessSpawner,
        crypto: yield* Crypto.Crypto,
        fileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ServerConfig.ServerConfig,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          scriptPath,
          childProcessSpawner,
          fileSystem,
          ...(options.replayGate === undefined ? {} : { replayGate: options.replayGate }),
        }),
        assertComplete: makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript),
      });
      return [adapter];
    }),
  ).pipe(
    Layer.provide(Layer.mergeAll(serverConfigLayer, NodeServices.layer, IdAllocator.layer)),
    // Held inbound lines must not outlive the scenario and wedge teardown.
    Layer.merge(
      Layer.effectDiscard(
        Effect.addFinalizer(() => Effect.sync(() => options.replayGate?.releaseAll())),
      ),
    ),
  );
}

export const KiroOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  AcpReplayTranscript,
  AcpReplayTranscriptDecodeError
> = {
  driver: KIRO_PROVIDER,
  decodeTranscript: (transcript) => decodeAcpReplayTranscript(transcript, KIRO_PROVIDER),
  makeProviderAdapterRegistryLayer: makeKiroProviderAdapterRegistryReplayLayer,
};
