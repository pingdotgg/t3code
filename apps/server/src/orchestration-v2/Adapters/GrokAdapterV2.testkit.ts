import * as NodeServices from "@effect/platform-node/NodeServices";
import { GrokSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";

import { ServerConfig } from "../../config.ts";
import {
  GROK_ACP_CANCEL_META,
  GROK_ACP_INITIALIZE_META,
} from "../../provider/acp/GrokAcpSupport.ts";
import { makeXAiPromptCompletionRuntime } from "../../provider/acp/XAiAcpExtension.ts";
import { layer as idAllocatorLayer, IdAllocatorV2 } from "../IdAllocator.ts";
import * as ProviderContinuationRequests from "../ProviderContinuationRequests.ts";
import { makeLayerEffect as makeProviderAdapterRegistryLayerEffect } from "../ProviderAdapterRegistry.ts";
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
import { GROK_DEFAULT_INSTANCE_ID, GROK_PROVIDER, makeGrokAdapterV2 } from "./GrokAdapterV2.ts";

const DEFAULT_GROK_SETTINGS = Schema.decodeUnknownSync(GrokSettings)({});

function makeGrokProviderAdapterRegistryReplayLayer(
  transcript: AcpReplayTranscript,
  options: { readonly replayGate?: ProviderReplayGate } = {},
) {
  const serverConfigLayer = Layer.effect(
    ServerConfig,
    makeReplayServerConfig(`grok-${transcript.scenario}`).pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer));

  return makeProviderAdapterRegistryLayerEffect(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const hostPlatform = yield* HostProcessPlatform;
      const idAllocator = yield* IdAllocatorV2;
      const serverConfig = yield* ServerConfig;
      // Same queue the continuation worker drains when the fixture runs it.
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const replayGate = options.replayGate;
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
        hostPlatform,
        childProcessSpawner,
        crypto,
        fileSystem,
        idAllocator,
        serverConfig,
        selfInvocation: yield* resolveSelfInvocation(),
        // Same wrapping as makeGrokAcpRuntime: client type and Ctrl+C cancel
        // metadata and the x.ai prompt-completion race, so replay sends what
        // production sends.
        makeRuntime: (runtimeInput) =>
          makeAcpReplayRuntime({
            transcript,
            statusPath,
            scriptPath,
            childProcessSpawner,
            fileSystem,
            ...(replayGate === undefined ? {} : { replayGate }),
            cancelMeta: GROK_ACP_CANCEL_META,
            initializeMeta: GROK_ACP_INITIALIZE_META,
          })(runtimeInput).pipe(Effect.flatMap(makeXAiPromptCompletionRuntime)),
        continuationRequests,
        assertComplete: makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript),
        ...(replayGate === undefined
          ? {}
          : {
              testHooks: {
                onDeferredFinalizeScheduled: (debounce) =>
                  Effect.sync(() => replayGate.recordFinishArmed(debounce)),
              },
            }),
      });
      return [adapter];
    }),
  ).pipe(
    Layer.provide(Layer.mergeAll(serverConfigLayer, NodeServices.layer, idAllocatorLayer)),
    // Held inbound lines must not outlive the scenario and wedge teardown.
    Layer.merge(
      Layer.effectDiscard(
        Effect.addFinalizer(() => Effect.sync(() => options.replayGate?.releaseAll())),
      ),
    ),
  );
}

export const GrokOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  AcpReplayTranscript,
  AcpReplayTranscriptDecodeError
> = {
  driver: GROK_PROVIDER,
  decodeTranscript: (transcript) => decodeAcpReplayTranscript(transcript, GROK_PROVIDER),
  makeProviderAdapterRegistryLayer: makeGrokProviderAdapterRegistryReplayLayer,
};
