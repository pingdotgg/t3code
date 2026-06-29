import * as NodeServices from "@effect/platform-node/NodeServices";
import { GrokSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { layer as idAllocatorLayer, IdAllocatorV2 } from "../IdAllocator.ts";
import { makeLayerEffect as makeProviderAdapterRegistryLayerEffect } from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import { makeReplayServerConfig } from "../testkit/ProviderReplayHarness.ts";
import {
  type AcpReplayTranscript,
  AcpReplayTranscriptDecodeError,
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";
import { GROK_DEFAULT_INSTANCE_ID, GROK_PROVIDER, makeGrokAdapterV2 } from "./GrokAdapterV2.ts";

const DEFAULT_GROK_SETTINGS = Schema.decodeUnknownSync(GrokSettings)({});

export function makeGrokProviderAdapterRegistryReplayLayer(transcript: AcpReplayTranscript) {
  const serverConfigLayer = Layer.effect(
    ServerConfig,
    makeReplayServerConfig(`grok-${transcript.scenario}`).pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer));

  return makeProviderAdapterRegistryLayerEffect(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocatorV2;
      const serverConfig = yield* ServerConfig;
      const replayDir = yield* fileSystem
        .makeTempDirectory({
          prefix: `t3-orchestration-v2-grok-replay-${transcript.scenario}-`,
        })
        .pipe(Effect.orDie);
      const statusPath = path.join(replayDir, "status.json");
      const scriptPath = yield* path
        .fromFileUrl(new URL("../../../scripts/acp-replay-agent.ts", import.meta.url))
        .pipe(Effect.orDie);
      const adapter = makeGrokAdapterV2({
        instanceId: GROK_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_GROK_SETTINGS,
        environment: {},
        childProcessSpawner,
        fileSystem,
        idAllocator,
        serverConfig,
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          scriptPath,
          childProcessSpawner,
        }),
        assertComplete: makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript),
      });
      return [adapter];
    }),
  ).pipe(Layer.provide(Layer.mergeAll(serverConfigLayer, NodeServices.layer, idAllocatorLayer)));
}

export const GrokOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  AcpReplayTranscript,
  AcpReplayTranscriptDecodeError
> = {
  driver: GROK_PROVIDER,
  decodeTranscript: (transcript) => decodeAcpReplayTranscript(transcript, GROK_PROVIDER),
  makeProviderAdapterRegistryLayer: makeGrokProviderAdapterRegistryReplayLayer,
};
