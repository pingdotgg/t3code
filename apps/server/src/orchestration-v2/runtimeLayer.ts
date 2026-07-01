import * as Layer from "effect/Layer";
import {
  OrchestrationEventInfrastructureLayerLive,
  OrchestrationLayerLive,
} from "../orchestration/runtimeLayer.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { layer as projectServiceLayer } from "../project/ProjectService.ts";
import { layer as projectSetupScriptRunnerLayer } from "../project/ProjectSetupScriptRunner.ts";
import { layer as checkpointCaptureServiceLayer } from "./CheckpointCaptureService.ts";
import { layer as checkpointServiceLayer } from "./CheckpointService.ts";
import { layer as checkpointRollbackServiceLayer } from "./CheckpointRollbackService.ts";
import { layer as commandPolicyLayer } from "./CommandPolicy.ts";
import { layerFromApplicationReceipts as commandReceiptStoreLayer } from "./CommandReceiptStore.ts";
import { layer as contextHandoffServiceLayer } from "./ContextHandoffService.ts";
import { layer as effectOutboxLayer } from "./EffectOutbox.ts";
import {
  executorLayer as effectExecutorLayer,
  layer as effectWorkerLayer,
} from "./EffectWorker.ts";
import { layerFromStores as eventSinkLayer } from "./EventSink.ts";
import { layerFromOrchestrationEventStore as eventStoreLayer } from "./EventStore.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import { layer as orchestratorLayer } from "./Orchestrator.ts";
import { layer as projectionStoreLayer } from "./ProjectionStore.ts";
import { layer as projectionMaintenanceLayer } from "./ProjectionMaintenance.ts";
import { layerFromProviderInstanceRegistry as providerAdapterRegistryLayerFromProviderInstances } from "./ProviderAdapterRegistry.ts";
import { layer as providerEventIngestorLayer } from "./ProviderEventIngestor.ts";
import { layer as providerSessionManagerLayer } from "./ProviderSessionManager.ts";
import { layer as providerRuntimeRecoveryLayer } from "./ProviderRuntimeRecoveryService.ts";
import { layer as providerSwitchServiceLayer } from "./ProviderSwitchService.ts";
import { layer as providerTurnControlServiceLayer } from "./ProviderTurnControlService.ts";
import { layer as providerTurnStartServiceLayer } from "./ProviderTurnStartService.ts";
import { layer as runExecutionServiceLayer } from "./RunExecutionService.ts";
import { layer as runFinalizationServiceLayer } from "./RunFinalizationService.ts";
import { layerFromProjectRepository as runtimePolicyLayerFromProjectRepository } from "./RuntimePolicy.ts";
import { layer as runtimeRequestServiceLayer } from "./RuntimeRequestService.ts";
import { layer as threadManagementServiceLayer } from "./ThreadManagementService.ts";
import { layer as threadLaunchServiceLayer } from "./ThreadLaunchService.ts";
import { layer as threadLifecycleServiceLayer } from "./ThreadLifecycleService.ts";
import { layer as threadForkServiceLayer } from "./ThreadForkService.ts";
import { layer as turnItemPositionStoreLayer } from "./TurnItemPositionStore.ts";
import { layer as scheduledTaskServiceLayer } from "../scheduledTasks/ScheduledTaskService.ts";

export const ProjectServiceLayerLive = projectServiceLayer.pipe(
  Layer.provide(Layer.merge(ProjectionProjectRepositoryLive, OrchestrationLayerLive)),
);
const runtimePolicyProvided = runtimePolicyLayerFromProjectRepository.pipe(
  Layer.provide(ProjectionProjectRepositoryLive),
);

const eventStoreProvided = eventStoreLayer.pipe(
  Layer.provide(OrchestrationEventInfrastructureLayerLive),
);
const commandReceiptStoreProvided = commandReceiptStoreLayer.pipe(
  Layer.provide(OrchestrationEventInfrastructureLayerLive),
);

const storesLayer = Layer.mergeAll(
  OrchestrationEventInfrastructureLayerLive,
  eventStoreProvided,
  projectionStoreLayer,
  commandReceiptStoreProvided,
  effectOutboxLayer,
  turnItemPositionStoreLayer,
);

const eventSinkProvided = eventSinkLayer.pipe(Layer.provide(storesLayer));
const projectionMaintenanceProvided = projectionMaintenanceLayer.pipe(Layer.provide(storesLayer));

const providerEventIngestorProvided = providerEventIngestorLayer.pipe(
  Layer.provide(Layer.mergeAll(eventSinkProvided, idAllocatorLayer)),
);

const checkpointServiceProvided = checkpointServiceLayer.pipe(Layer.provide(idAllocatorLayer));
const contextHandoffServiceProvided = contextHandoffServiceLayer.pipe(
  Layer.provide(idAllocatorLayer),
);

const providerAdapterRegistryProvided = providerAdapterRegistryLayerFromProviderInstances;
const providerSwitchServiceProvided = providerSwitchServiceLayer.pipe(
  Layer.provide(providerAdapterRegistryProvided),
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
      contextHandoffServiceProvided,
      eventSinkProvided,
      idAllocatorLayer,
      projectionStoreLayer,
      providerSessionManagerProvided,
      runExecutionServiceProvided,
      runtimePolicyProvided,
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
      runtimePolicyProvided,
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
const runFinalizationServiceProvided = runFinalizationServiceLayer.pipe(
  Layer.provide(Layer.merge(checkpointCaptureServiceProvided, projectionStoreLayer)),
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
const providerRuntimeRecoveryProvided = providerRuntimeRecoveryLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      effectWorkerProvided,
      storesLayer,
      eventSinkProvided,
      idAllocatorLayer,
      projectionStoreLayer,
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
      effectWorkerProvided,
      commandReceiptStoreProvided,
      contextHandoffServiceProvided,
      idAllocatorLayer,
      providerAdapterRegistryProvided,
      providerEventIngestorProvided,
      runtimePolicyProvided,
      providerSessionManagerProvided,
      providerSwitchServiceProvided,
      runExecutionServiceProvided,
      threadForkServiceLayer,
    ),
  ),
);

const threadManagementProvided = threadManagementServiceLayer.pipe(
  Layer.provide(orchestratorProvided),
);
export const ProjectSetupScriptRunnerLayerLive = projectSetupScriptRunnerLayer.pipe(
  Layer.provide(ProjectServiceLayerLive),
);
const threadLaunchProvided = threadLaunchServiceLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectServiceLayerLive,
      ProjectSetupScriptRunnerLayerLive,
      threadManagementProvided,
      commandReceiptStoreProvided,
      idAllocatorLayer,
    ),
  ),
);
const threadLifecycleProvided = threadLifecycleServiceLayer.pipe(
  Layer.provide(threadManagementProvided),
);
const scheduledTaskProvided = scheduledTaskServiceLayer.pipe(
  Layer.provide(Layer.mergeAll(threadLaunchProvided, threadManagementProvided)),
);

export const OrchestrationV2LayerLive = Layer.mergeAll(
  orchestratorProvided,
  threadManagementProvided,
  effectWorkerProvided,
  providerSessionManagerProvided,
  providerRuntimeRecoveryProvided,
  projectionMaintenanceProvided,
);

export const OrchestrationV2ProductionLayerLive = Layer.mergeAll(
  OrchestrationLayerLive,
  OrchestrationV2LayerLive,
  ProjectServiceLayerLive,
  threadLaunchProvided,
  threadLifecycleProvided,
  scheduledTaskProvided,
);
