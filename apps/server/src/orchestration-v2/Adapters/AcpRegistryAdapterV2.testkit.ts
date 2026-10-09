import * as NodeServices from "@effect/platform-node/NodeServices";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import { layerTestProviderHost } from "@t3tools/provider-testing/host";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import {
  type AcpReplayTranscript,
  AcpReplayTranscriptDecodeError,
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";
import {
  ACP_REGISTRY_DEFAULT_INSTANCE_ID,
  ACP_REGISTRY_PROVIDER,
  makeAcpRegistryAdapterV2,
} from "@t3tools/provider-acp-registry/testing";

const REPLAY_SETTINGS = Schema.decodeUnknownSync(AcpRegistrySettings)({
  agentId: "replay-agent",
  authMethodId: "replay",
});

function layerAcpRegistryProviderAdapterRegistryReplay(
  transcript: AcpReplayTranscript,
  options: { readonly replayGate?: ProviderReplayGate } = {},
) {
  const layerHost = layerTestProviderHost().pipe(Layer.provide(NodeServices.layer));

  return ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const replayGate = options.replayGate;
      const replayDir = yield* fileSystem
        .makeTempDirectory({
          prefix: `t3-orchestration-v2-acp-registry-replay-${transcript.scenario}-`,
        })
        .pipe(Effect.orDie);
      const statusPath = path.join(replayDir, "status.json");
      const scriptPath = yield* path
        .fromFileUrl(new URL("../../../scripts/acp-replay-agent.ts", import.meta.url))
        .pipe(Effect.orDie);
      const adapter = yield* makeAcpRegistryAdapterV2({
        instanceId: ACP_REGISTRY_DEFAULT_INSTANCE_ID,
        settings: REPLAY_SETTINGS,
        environment: {},
        childProcessSpawner,
        resolver: {
          resolve: () => Effect.die("ACP registry resolver must not run during replay"),
        },
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          scriptPath,
          childProcessSpawner,
          fileSystem,
          ...(replayGate === undefined ? {} : { replayGate }),
        }),
        assertComplete: makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript),
      });
      return [adapter];
    }),
  ).pipe(
    Layer.provide(Layer.mergeAll(layerHost, NodeServices.layer, IdAllocator.layer)),
    // Held inbound lines must not outlive the scenario and wedge teardown.
    Layer.merge(
      Layer.effectDiscard(
        Effect.addFinalizer(() => Effect.sync(() => options.replayGate?.releaseAll())),
      ),
    ),
  );
}

export const AcpRegistryOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  AcpReplayTranscript,
  AcpReplayTranscriptDecodeError
> = {
  driver: ACP_REGISTRY_PROVIDER,
  decodeTranscript: (transcript) =>
    decodeAcpReplayTranscript(transcript, ACP_REGISTRY_PROVIDER, {
      retargetProvider: true,
    }),
  makeProviderAdapterRegistryLayer: layerAcpRegistryProviderAdapterRegistryReplay,
};
