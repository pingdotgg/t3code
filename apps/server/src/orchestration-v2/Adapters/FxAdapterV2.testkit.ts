import * as NodeServices from "@effect/platform-node/NodeServices";
import { FxSettings } from "@t3tools/provider-fx/settings";
import {
  FX_ACP_CANCEL_BEHAVIOR,
  FX_DRIVER_KIND,
  makeFxAdapterV2,
} from "@t3tools/provider-fx/testing";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import {
  type AcpReplayTranscript,
  AcpReplayTranscriptDecodeError,
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";

const DEFAULT_FX_SETTINGS = Schema.decodeUnknownSync(FxSettings)({});
const FX_INSTANCE_ID = ProviderInstanceId.make("fx");

function layerFxProviderAdapterRegistryReplay(
  transcript: AcpReplayTranscript,
  options: { readonly replayGate?: ProviderReplayGate } = {},
) {
  const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));

  return ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const replayGate = options.replayGate;
      const replayDir = yield* fileSystem
        .makeTempDirectory({
          prefix: `t3-orchestration-v2-fx-replay-${transcript.scenario}-`,
        })
        .pipe(Effect.orDie);
      const statusPath = path.join(replayDir, "status.json");
      const scriptPath = yield* path
        .fromFileUrl(new URL("../../../scripts/acp-replay-agent.ts", import.meta.url))
        .pipe(Effect.orDie);
      const adapter = yield* makeFxAdapterV2({
        instanceId: FX_INSTANCE_ID,
        settings: DEFAULT_FX_SETTINGS,
        environment: {},
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (runtimeInput) =>
          makeAcpReplayRuntime({
            transcript,
            statusPath,
            scriptPath,
            childProcessSpawner,
            fileSystem,
            cancelBehavior: FX_ACP_CANCEL_BEHAVIOR,
            ...(replayGate === undefined ? {} : { replayGate }),
          })(runtimeInput),
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
    Layer.provide(Layer.mergeAll(layerHost, NodeServices.layer, IdAllocator.layer)),
    Layer.merge(
      Layer.effectDiscard(
        Effect.addFinalizer(() => Effect.sync(() => options.replayGate?.releaseAll())),
      ),
    ),
  );
}

export const FxOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  AcpReplayTranscript,
  AcpReplayTranscriptDecodeError
> = {
  driver: FX_DRIVER_KIND,
  decodeTranscript: (transcript) => decodeAcpReplayTranscript(transcript, FX_DRIVER_KIND),
  makeProviderAdapterRegistryLayer: layerFxProviderAdapterRegistryReplay,
};
