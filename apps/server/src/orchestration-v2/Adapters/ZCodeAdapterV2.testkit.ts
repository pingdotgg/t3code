import * as NodeServices from "@effect/platform-node/NodeServices";
import { ZCodeSettings } from "@t3tools/provider-zcode/settings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";

import { layerTestProviderHost } from "@t3tools/provider-testing/host";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/continuationRequests";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import {
  type AcpReplayTranscript,
  AcpReplayTranscriptDecodeError,
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";
import {
  makeZCodeAdapterV2,
  ZCODE_DEFAULT_INSTANCE_ID,
  ZCODE_PROVIDER,
} from "@t3tools/provider-zcode/testing";

const DEFAULT_ZCODE_SETTINGS = Schema.decodeSync(ZCodeSettings)({});

function layerZCodeProviderAdapterRegistryReplay(transcript: AcpReplayTranscript) {
  const layerHost = layerTestProviderHost().pipe(Layer.provide(NodeServices.layer));

  return ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const replayDir = yield* fileSystem
        .makeTempDirectory({
          prefix: `t3-orchestration-v2-zcode-replay-${transcript.scenario}-`,
        })
        .pipe(Effect.orDie);
      const statusPath = path.join(replayDir, "status.json");
      const scriptPath = yield* path
        .fromFileUrl(new URL("../../../scripts/acp-replay-agent.ts", import.meta.url))
        .pipe(Effect.orDie);
      const adapter = yield* makeZCodeAdapterV2({
        instanceId: ZCODE_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_ZCODE_SETTINGS,
        environment: {},
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          scriptPath,
          childProcessSpawner,
          fileSystem,
        }),
        continuationRequests: yield* ProviderContinuationRequests.ProviderContinuationRequests,
        assertComplete: makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript),
      });
      return [adapter];
    }),
  ).pipe(Layer.provide(Layer.mergeAll(layerHost, NodeServices.layer, IdAllocator.layer)));
}

export const ZCodeOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  AcpReplayTranscript,
  AcpReplayTranscriptDecodeError
> = {
  driver: ZCODE_PROVIDER,
  decodeTranscript: (transcript) => decodeAcpReplayTranscript(transcript, ZCODE_PROVIDER),
  makeProviderAdapterRegistryLayer: layerZCodeProviderAdapterRegistryReplay,
};
