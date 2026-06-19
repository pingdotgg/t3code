import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import { OpenCodeRuntimeLive } from "../provider/opencodeRuntime.ts";
import { claudeAgentSdkQueryRunnerLiveLayer } from "./Adapters/ClaudeAdapterV2.ts";
import { codexAppServerClientFactoryFromSettingsLayer } from "./Adapters/CodexAdapterV2.ts";
import { cursorAgentSdkRunnerLiveLayer } from "./Adapters/CursorAgentSdk.ts";
import { BUILT_IN_PROVIDER_ADAPTER_DRIVERS_V2 } from "./builtInProviderAdapterDrivers.ts";
import { layer as checkpointServiceLayer } from "./CheckpointService.ts";
import { layer as commandPolicyLayer } from "./CommandPolicy.ts";
import { layer as commandReceiptStoreLayer } from "./CommandReceiptStore.ts";
import { layer as contextHandoffServiceLayer } from "./ContextHandoffService.ts";
import { layer as eventSinkLayer } from "./EventSink.ts";
import { layer as eventStoreLayer } from "./EventStore.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import { layer as orchestratorLayer } from "./Orchestrator.ts";
import { layer as projectionStoreLayer } from "./ProjectionStore.ts";
import { ProviderAdapterV2 } from "./ProviderAdapter.ts";
import { makeLayerEffect as providerAdapterRegistryLayerFromEffect } from "./ProviderAdapterRegistry.ts";
import { layer as providerEventIngestorLayer } from "./ProviderEventIngestor.ts";
import { layer as providerSessionManagerLayer } from "./ProviderSessionManager.ts";
import { layer as runExecutionServiceLayer } from "./RunExecutionService.ts";
import { layer as runtimePolicyLayer } from "./RuntimePolicy.ts";
import { layer as threadManagementServiceLayer } from "./ThreadManagementService.ts";

const storesLayer = Layer.merge(eventStoreLayer, projectionStoreLayer);

const eventSinkProvided = eventSinkLayer.pipe(Layer.provide(storesLayer));

const commandReceiptStoreProvided = commandReceiptStoreLayer;

const providerEventIngestorProvided = providerEventIngestorLayer.pipe(
  Layer.provide(Layer.mergeAll(eventSinkProvided, idAllocatorLayer)),
);

const checkpointServiceProvided = checkpointServiceLayer.pipe(Layer.provide(idAllocatorLayer));
const contextHandoffServiceProvided = contextHandoffServiceLayer.pipe(
  Layer.provide(idAllocatorLayer),
);

const codexAdapterProvided = codexAdapterLayer.pipe(
  Layer.provide(codexAppServerClientFactoryFromSettingsLayer),
  Layer.provide(idAllocatorLayer),
);

const claudeAdapterProvided = claudeAdapterLayer.pipe(
  Layer.provide(claudeAgentSdkQueryRunnerLiveLayer),
  Layer.provide(cursorAgentSdkRunnerLiveLayer),
  Layer.provide(OpenCodeRuntimeLive),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(idAllocatorLayer),
);

const providerAdapterRegistryProvided = providerAdapterRegistryLayerFromEffect(
  Effect.all([
    Effect.service(ProviderAdapterV2).pipe(Effect.provide(codexAdapterProvided)),
    Effect.service(ProviderAdapterV2).pipe(Effect.provide(claudeAdapterProvided)),
  ]),
);

const providerSessionManagerProvided = providerSessionManagerLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      providerAdapterRegistryProvided,
      eventSinkProvided,
      idAllocatorLayer,
      projectionStoreLayer,
    ),
  ),
);

const runExecutionServiceProvided = runExecutionServiceLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      checkpointServiceProvided,
      eventSinkProvided,
      idAllocatorLayer,
      providerEventIngestorProvided,
    ),
  ),
);

const orchestratorProvided = orchestratorLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      checkpointServiceProvided,
      commandPolicyLayer,
      storesLayer,
      eventSinkProvided,
      commandReceiptStoreProvided,
      contextHandoffServiceProvided,
      idAllocatorLayer,
      providerEventIngestorProvided,
      runtimePolicyLayer,
      providerSessionManagerProvided,
      runExecutionServiceProvided,
    ),
  ),
);

export const OrchestrationV2LayerLive = Layer.merge(
  orchestratorProvided,
  threadManagementServiceLayer.pipe(Layer.provide(orchestratorProvided)),
);
