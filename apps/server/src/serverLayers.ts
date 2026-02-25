import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { ServerConfig } from "./config";
import { CheckpointStore } from "./checkpointing/Services/CheckpointStore";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { makeCodexAdapterLive } from "./provider/Layers/CodexAdapter";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry";
import { makeProviderServiceLive } from "./provider/Layers/ProviderService";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory";
import { ProviderService } from "./provider/Services/ProviderService";

import { makeTerminalManagerLive, TerminalManager } from "./terminalManager";
import { PtyAdapter } from "./ptyAdapter";
import { Keybindings, KeybindingsLive } from "./keybindings";

export function makeServerProviderLayer(): Layer.Layer<
  ProviderService,
  unknown,
  SqlClient.SqlClient | ServerConfig
> {
  return Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    const providerLogsDir = path.join(stateDir, "logs", "providers");
    const codexAdapterLayer = makeCodexAdapterLive({
      nativeEventLogPath: path.join(providerLogsDir, "provider-native.ndjson"),
    });
    const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(Layer.provide(codexAdapterLayer));
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    return makeProviderServiceLive({
      canonicalEventLogPath: path.join(providerLogsDir, "provider-canonical.ndjson"),
    }).pipe(Layer.provide(adapterRegistryLayer), Layer.provide(providerSessionDirectoryLayer));
  }).pipe(Layer.unwrap);
}

export function makeServerRuntimeServicesLayer(): Layer.Layer<
  | OrchestrationEngineService
  | ProjectionSnapshotQuery
  | CheckpointStore
  | OrchestrationReactor
  | TerminalManager
  | Keybindings,
  unknown,
  SqlClient.SqlClient | ProviderService | ServerConfig
> {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );
  const checkpointStoreLayer = CheckpointStoreLive.pipe(Layer.provide(NodeServices.layer));

  const runtimeServicesLayer = Layer.mergeAll(
    orchestrationLayer,
    OrchestrationProjectionSnapshotQueryLive,
    checkpointStoreLayer,
  );
  const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const checkpointReactorLayer = CheckpointReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
    Layer.provideMerge(runtimeIngestionLayer),
    Layer.provideMerge(providerCommandReactorLayer),
    Layer.provideMerge(checkpointReactorLayer),
  );

  const terminalLayer = Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    return makeTerminalManagerLive({
      logsDir: path.join(stateDir, "logs", "terminals"),
    }).pipe(Layer.provide(PtyAdapter.layer()));
  }).pipe(Layer.unwrap);

  const keybindingsLayer = KeybindingsLive.pipe(Layer.provide(NodeServices.layer));

  return Layer.mergeAll(orchestrationReactorLayer, terminalLayer, keybindingsLayer);
}
