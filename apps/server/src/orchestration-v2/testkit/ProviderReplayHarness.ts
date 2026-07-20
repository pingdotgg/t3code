import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderDriverKind, ProviderReplayTranscript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { MigrationError } from "effect/unstable/sql/Migrator";
import type { SqlError } from "effect/unstable/sql/SqlError";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { layer as mcpSessionRegistryTestLayer } from "../../mcp/McpSessionRegistry.testkit.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { layer as checkpointCaptureServiceLayer } from "../CheckpointCaptureService.ts";
import { layer as checkpointServiceLayer } from "../CheckpointService.ts";
import { layer as checkpointRollbackServiceLayer } from "../CheckpointRollbackService.ts";
import { layer as commandPolicyLayer } from "../CommandPolicy.ts";
import { layer as commandReceiptStoreLayer } from "../CommandReceiptStore.ts";
import { layer as contextHandoffServiceLayer } from "../ContextHandoffService.ts";
import { layer as effectOutboxLayer } from "../EffectOutbox.ts";
import {
  executorLayer as effectExecutorLayer,
  layer as effectWorkerLayer,
  runDaemon as runEffectWorkerDaemon,
} from "../EffectWorker.ts";
import { layerFromStores as eventSinkLayer } from "../EventSink.ts";
import { layer as eventStoreLayer } from "../EventStore.ts";
import { layer as idAllocatorLayer } from "../IdAllocator.ts";
import { layer as orchestratorLayer } from "../Orchestrator.ts";
import { layer as projectionStoreLayer } from "../ProjectionStore.ts";
import { OrchestratorV2, type OrchestratorV2Error } from "../Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "../ProviderAdapterRegistry.ts";
import { layer as providerEventIngestorLayer } from "../ProviderEventIngestor.ts";
import { layerWithOptions as providerSessionManagerLayerWithOptions } from "../ProviderSessionManager.ts";
import { layer as providerSwitchServiceLayer } from "../ProviderSwitchService.ts";
import { layer as providerTurnControlServiceLayer } from "../ProviderTurnControlService.ts";
import { layer as providerTurnStartServiceLayer } from "../ProviderTurnStartService.ts";
import { layer as runExecutionServiceLayer } from "../RunExecutionService.ts";
import { layer as runFinalizationServiceLayer } from "../RunFinalizationService.ts";
import {
  layer as runtimePolicyLayer,
  layerWithOverride as runtimePolicyLayerWithOverride,
  type RuntimePolicyV2Override,
} from "../RuntimePolicy.ts";
import { layer as turnItemPositionStoreLayer } from "../TurnItemPositionStore.ts";
import { layer as runtimeRequestServiceLayer } from "../RuntimeRequestService.ts";
import { layer as threadForkServiceLayer } from "../ThreadForkService.ts";
import {
  runOrchestratorV2Scenario,
  type OrchestratorV2ScenarioStepError,
  type OrchestratorV2Scenario,
  type OrchestratorV2ScenarioResult,
} from "./OrchestratorScenario.ts";

export function makeReplayServerConfig(
  scenario: string,
): Effect.Effect<
  ServerConfig["Service"],
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const safeScenario = scenario.replace(/[^a-z0-9_-]+/gi, "-");
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectory({
      prefix: `t3-orchestration-v2-replay-${safeScenario}-`,
    });
    const stateDir = path.join(baseDir, "userdata");
    const logsDir = path.join(stateDir, "logs");
    const providerLogsDir = path.join(logsDir, "provider");
    const terminalLogsDir = path.join(logsDir, "terminals");
    const attachmentsDir = path.join(stateDir, "attachments");
    const worktreesDir = path.join(baseDir, "worktrees");
    const providerStatusCacheDir = path.join(baseDir, "caches");

    for (const directory of [
      stateDir,
      logsDir,
      providerLogsDir,
      terminalLogsDir,
      attachmentsDir,
      worktreesDir,
      providerStatusCacheDir,
    ]) {
      yield* fs.makeDirectory(directory, { recursive: true });
    }

    return {
      logLevel: "Error",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "t3-server",
      mode: "web",
      port: 0,
      host: undefined,
      cwd: process.cwd(),
      baseDir,
      staticDir: undefined,
      devUrl: undefined,
      noBrowser: false,
      startupPresentation: "browser",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      stateDir,
      dbPath: path.join(stateDir, "state.sqlite"),
      keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
      settingsPath: path.join(stateDir, "settings.json"),
      providerStatusCacheDir,
      worktreesDir,
      attachmentsDir,
      logsDir,
      serverLogPath: path.join(logsDir, "server.log"),
      serverTracePath: path.join(logsDir, "server.trace.ndjson"),
      providerLogsDir,
      providerEventLogPath: path.join(providerLogsDir, "events.log"),
      terminalLogsDir,
      anonymousIdPath: path.join(stateDir, "anonymous-id"),
      environmentIdPath: path.join(stateDir, "environment-id"),
      serverRuntimeStatePath: path.join(stateDir, "server-runtime.json"),
      secretsDir: path.join(stateDir, "secrets"),
    };
  });
}

export interface OrchestratorV2ProviderReplayScenario<
  Transcript extends ProviderReplayTranscript = ProviderReplayTranscript,
> extends OrchestratorV2Scenario {
  readonly transcript: Transcript;
  readonly runtimePolicyOverride?: RuntimePolicyV2Override;
}

export interface OrchestratorV2ProviderReplayHarness<
  Transcript extends ProviderReplayTranscript = ProviderReplayTranscript,
  Error = never,
> {
  readonly driver: ProviderDriverKind;
  readonly decodeTranscript: (
    transcript: ProviderReplayTranscript,
  ) => Effect.Effect<Transcript, Error>;
  readonly makeProviderAdapterRegistryLayer: (
    transcript: Transcript,
  ) => Layer.Layer<ProviderAdapterRegistryV2, Error>;
}

export function runOrchestratorV2ProviderReplayScenario<
  Transcript extends ProviderReplayTranscript,
  Error,
>(
  scenario: OrchestratorV2ProviderReplayScenario<Transcript>,
  harness: OrchestratorV2ProviderReplayHarness<Transcript, Error>,
  options: {
    readonly databaseLayer?: Layer.Layer<
      SqlClient.SqlClient,
      MigrationError | PlatformError.PlatformError | SqlError
    >;
    readonly enableAssistantStreaming?: boolean;
    readonly runEffectWorker?: boolean;
  } = {},
): Effect.Effect<
  OrchestratorV2ScenarioResult,
  | OrchestratorV2Error
  | OrchestratorV2ScenarioStepError
  | Error
  | MigrationError
  | PlatformError.PlatformError
  | SqlError,
  never
> {
  const layer = makeOrchestratorV2ProviderReplayLayer(scenario, harness, options);

  return runOrchestratorV2Scenario(scenario).pipe(Effect.provide(layer));
}

export function makeOrchestratorV2ProviderReplayLayer<
  Transcript extends ProviderReplayTranscript,
  Error,
>(
  scenario: OrchestratorV2ProviderReplayScenario<Transcript>,
  harness: OrchestratorV2ProviderReplayHarness<Transcript, Error>,
  options: {
    readonly databaseLayer?: Layer.Layer<
      SqlClient.SqlClient,
      MigrationError | PlatformError.PlatformError | SqlError
    >;
    readonly enableAssistantStreaming?: boolean;
    readonly runEffectWorker?: boolean;
  } = {},
): Layer.Layer<OrchestratorV2, Error | MigrationError | PlatformError.PlatformError | SqlError> {
  const registryLayer = harness.makeProviderAdapterRegistryLayer(scenario.transcript);
  return makeOrchestratorV2ReplayLayerWithRegistry(scenario, registryLayer, options);
}

export function makeOrchestratorV2ReplayLayerWithRegistry<Error>(
  scenario: Pick<OrchestratorV2ProviderReplayScenario, "name" | "runtimePolicyOverride">,
  registryLayer: Layer.Layer<ProviderAdapterRegistryV2, Error>,
  options: {
    readonly databaseLayer?: Layer.Layer<
      SqlClient.SqlClient,
      MigrationError | PlatformError.PlatformError | SqlError
    >;
    readonly enableAssistantStreaming?: boolean;
    readonly runEffectWorker?: boolean;
  } = {},
): Layer.Layer<OrchestratorV2, Error | MigrationError | PlatformError.PlatformError | SqlError> {
  const serverConfigLayer = Layer.effect(
    ServerConfig,
    makeReplayServerConfig(scenario.name).pipe(Effect.orDie),
  ).pipe(Layer.provide(NodeServices.layer));
  const runtimeLayer =
    scenario.runtimePolicyOverride === undefined
      ? runtimePolicyLayer
      : runtimePolicyLayerWithOverride(scenario.runtimePolicyOverride).pipe(
          Layer.provide(runtimePolicyLayer),
        );
  const databaseLayer = options.databaseLayer ?? SqlitePersistenceMemory;
  const serverSettingsLayer = ServerSettingsService.layerTest({
    enableAssistantStreaming: options.enableAssistantStreaming ?? false,
  }).pipe(Layer.orDie);
  const storesLayer = Layer.mergeAll(
    eventStoreLayer,
    projectionStoreLayer,
    commandReceiptStoreLayer,
    effectOutboxLayer,
    turnItemPositionStoreLayer,
  ).pipe(Layer.provide(databaseLayer));
  const eventSinkProvided = eventSinkLayer.pipe(
    Layer.provide(Layer.mergeAll(storesLayer, databaseLayer)),
  );
  const commandReceiptStoreProvided = commandReceiptStoreLayer.pipe(Layer.provide(databaseLayer));
  const providerEventIngestorProvided = providerEventIngestorLayer.pipe(
    Layer.provide(Layer.mergeAll(storesLayer, eventSinkProvided, idAllocatorLayer)),
  );
  const vcsDriverRegistryLayer = VcsDriverRegistry.layer.pipe(
    Layer.provide(VcsProcess.layer),
    Layer.provide(serverConfigLayer),
    Layer.provide(NodeServices.layer),
  );
  const checkpointStoreLayer = CheckpointStore.layer.pipe(
    Layer.provide(vcsDriverRegistryLayer),
    Layer.provide(NodeServices.layer),
  );
  const checkpointServiceProvided = checkpointServiceLayer.pipe(
    Layer.provide(Layer.mergeAll(checkpointStoreLayer, idAllocatorLayer)),
  );
  const contextHandoffServiceProvided = contextHandoffServiceLayer.pipe(
    Layer.provide(idAllocatorLayer),
  );
  const persistenceLayer = Layer.mergeAll(
    storesLayer,
    eventSinkProvided,
    commandReceiptStoreProvided,
    idAllocatorLayer,
    providerEventIngestorProvided,
  );
  const providerSessionManagerProvided = providerSessionManagerLayerWithOptions({
    configureMcp: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        registryLayer,
        eventSinkProvided,
        idAllocatorLayer,
        mcpSessionRegistryTestLayer,
        storesLayer,
      ),
    ),
  );
  const providerSwitchServiceProvided = providerSwitchServiceLayer.pipe(
    Layer.provide(registryLayer),
  );
  const runExecutionServiceProvided = runExecutionServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        checkpointServiceProvided,
        eventSinkProvided,
        idAllocatorLayer,
        providerEventIngestorProvided,
        serverSettingsLayer,
      ),
    ),
  );
  const providerTurnStartServiceProvided = providerTurnStartServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        contextHandoffServiceProvided,
        eventSinkProvided,
        idAllocatorLayer,
        storesLayer,
        providerSessionManagerProvided,
        runExecutionServiceProvided,
        runtimeLayer,
      ),
    ),
  );
  const providerTurnControlServiceProvided = providerTurnControlServiceLayer.pipe(
    Layer.provide(Layer.merge(storesLayer, providerSessionManagerProvided)),
  );
  const runtimeRequestServiceProvided = runtimeRequestServiceLayer.pipe(
    Layer.provide(Layer.merge(storesLayer, providerSessionManagerProvided)),
  );
  const checkpointRollbackServiceProvided = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        checkpointServiceProvided,
        eventSinkProvided,
        idAllocatorLayer,
        storesLayer,
        providerSessionManagerProvided,
        runtimeLayer,
      ),
    ),
  );
  const checkpointCaptureServiceProvided = checkpointCaptureServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(checkpointServiceProvided, eventSinkProvided, idAllocatorLayer, storesLayer),
    ),
  );
  const runFinalizationServiceProvided = runFinalizationServiceLayer.pipe(
    Layer.provide(Layer.merge(checkpointCaptureServiceProvided, storesLayer)),
  );
  const effectExecutorProvided = effectExecutorLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        runFinalizationServiceProvided,
        checkpointRollbackServiceProvided,
        providerSessionManagerProvided,
        providerTurnControlServiceProvided,
        providerTurnStartServiceProvided,
        runtimeRequestServiceProvided,
      ),
    ),
  );
  const effectWorkerProvided = effectWorkerLayer.pipe(
    Layer.provide(Layer.merge(storesLayer, effectExecutorProvided)),
  );
  const orchestratorProvided = orchestratorLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        checkpointServiceProvided,
        commandPolicyLayer,
        contextHandoffServiceProvided,
        effectWorkerProvided,
        persistenceLayer,
        registryLayer,
        runtimeLayer,
        providerSessionManagerProvided,
        providerSwitchServiceProvided,
        runExecutionServiceProvided,
        threadForkServiceLayer,
      ),
    ),
  );
  const replayRuntime = Layer.merge(orchestratorProvided, effectWorkerProvided);

  // Build the daemon from the exact worker instance exposed alongside the
  // orchestrator. Keeping this acquisition in the replay layer makes the
  // outbox lifecycle explicit and prevents test-only command-side draining.
  if (options.runEffectWorker === false) {
    return orchestratorProvided;
  }
  return Layer.effect(
    OrchestratorV2,
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      yield* runEffectWorkerDaemon.pipe(Effect.forkScoped);
      return orchestrator;
    }),
  ).pipe(Layer.provide(replayRuntime));
}
