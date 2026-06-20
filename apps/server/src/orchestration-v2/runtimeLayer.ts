import * as Layer from "effect/Layer";
import { layer as checkpointCaptureServiceLayer } from "./CheckpointCaptureService.ts";
import { layer as checkpointServiceLayer } from "./CheckpointService.ts";
import { layer as checkpointRollbackServiceLayer } from "./CheckpointRollbackService.ts";
import { layer as commandPolicyLayer } from "./CommandPolicy.ts";
import { layer as commandReceiptStoreLayer } from "./CommandReceiptStore.ts";
import { layer as contextHandoffServiceLayer } from "./ContextHandoffService.ts";
import { layer as effectOutboxLayer } from "./EffectOutbox.ts";
import {
  daemonLayer as effectWorkerDaemonLayer,
  executorLayer as effectExecutorLayer,
  layer as effectWorkerLayer,
} from "./EffectWorker.ts";
import { layerFromStores as eventSinkLayer } from "./EventSink.ts";
import { layer as eventStoreLayer } from "./EventStore.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import { layer as orchestratorLayer } from "./Orchestrator.ts";
import { layer as projectionStoreLayer } from "./ProjectionStore.ts";
import { layer as projectionMaintenanceLayer } from "./ProjectionMaintenance.ts";
import { layerFromProviderInstanceRegistry as providerAdapterRegistryLayerFromProviderInstances } from "./ProviderAdapterRegistry.ts";
import { layer as providerEventIngestorLayer } from "./ProviderEventIngestor.ts";
import { layer as providerSessionManagerLayer } from "./ProviderSessionManager.ts";
import { layer as providerSwitchServiceLayer } from "./ProviderSwitchService.ts";
import { layer as providerTurnControlServiceLayer } from "./ProviderTurnControlService.ts";
import { layer as providerTurnStartServiceLayer } from "./ProviderTurnStartService.ts";
import { layer as runExecutionServiceLayer } from "./RunExecutionService.ts";
import { layer as runtimePolicyLayer } from "./RuntimePolicy.ts";
import { layer as runtimeRequestServiceLayer } from "./RuntimeRequestService.ts";
import { layer as threadManagementServiceLayer } from "./ThreadManagementService.ts";
import { layer as threadForkServiceLayer } from "./ThreadForkService.ts";
import { layer as turnItemPositionStoreLayer } from "./TurnItemPositionStore.ts";

const storesLayer = Layer.mergeAll(
  eventStoreLayer,
  projectionStoreLayer,
  commandReceiptStoreLayer,
  effectOutboxLayer,
  turnItemPositionStoreLayer,
);

const eventSinkProvided = eventSinkLayer.pipe(Layer.provide(storesLayer));
const projectionMaintenanceProvided = projectionMaintenanceLayer.pipe(Layer.provide(storesLayer));

const commandReceiptStoreProvided = commandReceiptStoreLayer;

const providerEventIngestorProvided = providerEventIngestorLayer.pipe(
  Layer.provide(Layer.mergeAll(eventSinkProvided, idAllocatorLayer)),
);

const checkpointServiceProvided = checkpointServiceLayer.pipe(Layer.provide(idAllocatorLayer));
const contextHandoffServiceProvided = contextHandoffServiceLayer.pipe(
  Layer.provide(idAllocatorLayer),
);

const providerAdapterRegistryProvided = providerAdapterRegistryLayerFromProviderInstances;

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

const providerTurnStartServiceProvided = providerTurnStartServiceLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      eventSinkProvided,
      idAllocatorLayer,
      projectionStoreLayer,
      providerSessionManagerProvided,
      runExecutionServiceProvided,
      runtimePolicyLayer,
    ),
  ),
);

const providerTurnControlServiceProvided = providerTurnControlServiceLayer.pipe(
  Layer.provide(Layer.merge(projectionStoreLayer, providerSessionManagerProvided)),
);
const runtimeRequestServiceProvided = runtimeRequestServiceLayer.pipe(
  Layer.provide(Layer.merge(projectionStoreLayer, providerSessionManagerProvided)),
);
const checkpointRollbackServiceProvided = checkpointRollbackServiceLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      checkpointServiceProvided,
      eventSinkProvided,
      idAllocatorLayer,
      projectionStoreLayer,
      providerSessionManagerProvided,
      runtimePolicyLayer,
    ),
  ),
);
const checkpointCaptureServiceProvided = checkpointCaptureServiceLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      checkpointServiceProvided,
      eventSinkProvided,
      idAllocatorLayer,
      projectionStoreLayer,
    ),
  ),
);

const effectExecutorProvided = effectExecutorLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      checkpointCaptureServiceProvided,
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
const effectWorkerDaemonProvided = effectWorkerDaemonLayer.pipe(
  Layer.provide(effectWorkerProvided),
);

const orchestratorProvided = orchestratorLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      checkpointServiceProvided,
      commandPolicyLayer,
      storesLayer,
      eventSinkProvided,
      effectWorkerProvided,
      commandReceiptStoreProvided,
      contextHandoffServiceProvided,
      idAllocatorLayer,
      providerAdapterRegistryProvided,
      providerEventIngestorProvided,
      runtimePolicyLayer,
      providerSessionManagerProvided,
      providerSwitchServiceLayer,
      runExecutionServiceProvided,
      threadForkServiceLayer,
    ),
  ),
);

export const OrchestrationV2LayerLive = Layer.mergeAll(
  orchestratorProvided,
  threadManagementServiceLayer.pipe(Layer.provide(orchestratorProvided)),
  effectWorkerDaemonProvided,
  projectionMaintenanceProvided,
);
