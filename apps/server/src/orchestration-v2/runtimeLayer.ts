import { Layer } from "effect";

import { layer as codexAdapterLayer } from "./Adapters/CodexAdapterV2.ts";
import { codexAppServerClientFactoryFromSettingsLayer } from "./Adapters/CodexAdapterV2.ts";
import { layer as checkpointServiceLayer } from "./CheckpointService.ts";
import { layer as commandReceiptStoreLayer } from "./CommandReceiptStore.ts";
import { layer as eventSinkLayer } from "./EventSink.ts";
import { layer as eventStoreLayer } from "./EventStore.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import { layer as orchestratorLayer } from "./Orchestrator.ts";
import { layer as projectionStoreLayer } from "./ProjectionStore.ts";
import { layerFromProviderAdapter } from "./ProviderAdapterRegistry.ts";
import { layer as providerEventIngestorLayer } from "./ProviderEventIngestor.ts";
import { layer as providerSessionManagerLayer } from "./ProviderSessionManager.ts";
import { layer as runExecutionServiceLayer } from "./RunExecutionService.ts";
import { layer as runtimePolicyLayer } from "./RuntimePolicy.ts";

const storesLayer = Layer.merge(eventStoreLayer, projectionStoreLayer);

const eventSinkProvided = eventSinkLayer.pipe(Layer.provide(storesLayer));

const commandReceiptStoreProvided = commandReceiptStoreLayer;

const providerEventIngestorProvided = providerEventIngestorLayer.pipe(
  Layer.provide(Layer.mergeAll(eventSinkProvided, idAllocatorLayer)),
);

const checkpointServiceProvided = checkpointServiceLayer.pipe(Layer.provide(idAllocatorLayer));

const codexAdapterProvided = codexAdapterLayer.pipe(
  Layer.provide(codexAppServerClientFactoryFromSettingsLayer),
  Layer.provide(idAllocatorLayer),
);

const providerAdapterRegistryProvided = layerFromProviderAdapter.pipe(
  Layer.provide(codexAdapterProvided),
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

export const OrchestrationV2LayerLive = orchestratorLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      checkpointServiceProvided,
      storesLayer,
      eventSinkProvided,
      commandReceiptStoreProvided,
      idAllocatorLayer,
      providerEventIngestorProvided,
      runtimePolicyLayer,
      providerSessionManagerProvided,
      runExecutionServiceProvided,
    ),
  ),
);
