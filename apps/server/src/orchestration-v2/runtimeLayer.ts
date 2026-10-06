import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Layer from "effect/Layer";
import * as OrchestrationCommandReceipts from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import * as OrchestrationEventStore from "../persistence/Layers/OrchestrationEventStore.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { ProviderAuthServiceLive } from "../provider/Layers/ProviderAuthService.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as CommandPolicy from "./CommandPolicy.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "./ProviderContinuationRequests.ts";
import * as ProviderContinuationService from "./ProviderContinuationService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderSwitchService from "./ProviderSwitchService.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadLifecycleService from "./ThreadLifecycleService.ts";
import * as ThreadForkService from "./ThreadForkService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";

/** The shared application event log and its command receipts. */
export const OrchestrationEventInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationEventStore.OrchestrationEventStoreLive,
  OrchestrationCommandReceipts.OrchestrationCommandReceiptRepositoryLive,
);

const runtimePolicyProvided = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(ProjectStore.layer),
);

const eventStoreProvided = EventStore.layerFromOrchestrationEventStore.pipe(
  Layer.provide(OrchestrationEventInfrastructureLayerLive),
);
const commandReceiptStoreProvided = CommandReceiptStore.layerFromApplicationReceipts.pipe(
  Layer.provide(OrchestrationEventInfrastructureLayerLive),
);

const storesLayer = Layer.mergeAll(
  OrchestrationEventInfrastructureLayerLive,
  eventStoreProvided,
  ProjectionStore.layer,
  ProjectStore.layer,
  commandReceiptStoreProvided,
  EffectOutbox.layer,
  TurnItemPositionStore.layer,
);

export const OrchestrationV2EventSinkLayerLive = EventSink.layerFromStores.pipe(
  Layer.provide(storesLayer),
);
const eventSinkProvided = OrchestrationV2EventSinkLayerLive;
const projectionMaintenanceProvided = ProjectionMaintenance.layer.pipe(Layer.provide(storesLayer));
const legacyV1ThreadImporterProvided = LegacyV1ThreadImporter.layer.pipe(
  Layer.provide(eventSinkProvided),
);

export const ProjectServiceLayerLive = ProjectService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      ProjectionStore.layer,
      eventSinkProvided,
      IdAllocator.layer,
      legacyV1ThreadImporterProvided,
    ),
  ),
);

const providerEventIngestorProvided = ProviderEventIngestor.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      eventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
      ThreadCommandExecutor.layer,
    ),
  ),
);

const checkpointServiceProvided = CheckpointService.layer.pipe(Layer.provide(IdAllocator.layer));
const contextHandoffServiceProvided = ContextHandoffService.layer.pipe(
  Layer.provide(IdAllocator.layer),
);

const providerAdapterRegistryProvided = ProviderAdapterRegistry.layerFromProviderInstanceRegistry;
const providerSwitchServiceProvided = ProviderSwitchService.layer.pipe(
  Layer.provide(providerAdapterRegistryProvided),
);

const providerSessionManagerProvided = ProviderSessionManager.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      providerAdapterRegistryProvided,
      eventSinkProvided,
      IdAllocator.layer,
      providerEventIngestorProvided,
      ProjectionStore.layer,
    ),
  ),
);

const providerAuthServiceProvided = ProviderAuthServiceLive.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, providerSessionManagerProvided)),
);

const runExecutionServiceProvided = RunExecutionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      checkpointServiceProvided,
      eventSinkProvided,
      IdAllocator.layer,
      providerEventIngestorProvided,
    ),
  ),
);

const providerTurnStartServiceProvided = ProviderTurnStartService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      contextHandoffServiceProvided,
      eventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
      providerSessionManagerProvided,
      providerAuthServiceProvided,
      runExecutionServiceProvided,
      runtimePolicyProvided,
    ),
  ),
);

const providerTurnControlServiceProvided = ProviderTurnControlService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, providerSessionManagerProvided)),
);
const runtimeRequestServiceProvided = RuntimeRequestService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, providerSessionManagerProvided)),
);
const checkpointRollbackServiceProvided = CheckpointRollbackService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      checkpointServiceProvided,
      eventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
      providerSessionManagerProvided,
      runtimePolicyProvided,
    ),
  ),
);
const checkpointCaptureServiceProvided = CheckpointCaptureService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      checkpointServiceProvided,
      eventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
    ),
  ),
);
const runFinalizationServiceProvided = RunFinalizationService.layer.pipe(
  Layer.provide(Layer.merge(checkpointCaptureServiceProvided, ProjectionStore.layer)),
);

const orchestratorProvided = Orchestrator.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      checkpointServiceProvided,
      CommandPolicy.layer,
      storesLayer,
      eventSinkProvided,
      commandReceiptStoreProvided,
      contextHandoffServiceProvided,
      IdAllocator.layer,
      ProjectStore.layer,
      providerAdapterRegistryProvided,
      // Same layer reference as the continuation worker and the adapter
      // infrastructure so layer memoization yields one shared request queue.
      ProviderContinuationRequests.layer,
      providerEventIngestorProvided,
      runtimePolicyProvided,
      providerSessionManagerProvided,
      providerSwitchServiceProvided,
      runExecutionServiceProvided,
      ThreadForkService.layer,
    ),
  ),
);

const agentSessionImporterProvided = AgentSessionImporter.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AgentSessionScanner.layer,
      ProjectServiceLayerLive,
      orchestratorProvided,
      eventSinkProvided,
      IdAllocator.layer,
      ProviderSessionRuntime.layer,
    ),
  ),
);

const threadManagementProvided = ThreadManagementService.layerWithLegacyImporter.pipe(
  Layer.provide(Layer.merge(orchestratorProvided, legacyV1ThreadImporterProvided)),
);
export const ProjectSetupScriptRunnerLayerLive = ProjectSetupScriptRunner.layer.pipe(
  Layer.provide(ProjectServiceLayerLive),
);
const managedProjectFoldersProvided = ManagedProjectFolders.layer.pipe(
  Layer.provide(ProjectServiceLayerLive),
);
const threadLaunchProvided = ThreadLaunchService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectServiceLayerLive,
      ProjectSetupScriptRunnerLayerLive,
      managedProjectFoldersProvided,
      threadManagementProvided,
      commandReceiptStoreProvided,
      IdAllocator.layer,
    ),
  ),
);
const threadLifecycleProvided = ThreadLifecycleService.layer.pipe(
  Layer.provide(threadManagementProvided),
);
const secretRequestsProvided = SecretRequests.layer.pipe(Layer.provide(threadManagementProvided));
const scheduledTaskProvided = ScheduledTaskService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(threadLaunchProvided, threadManagementProvided, secretRequestsProvided),
  ),
);
const providerContinuationWorkerProvided = ProviderContinuationService.workerLive.pipe(
  Layer.provide(
    Layer.mergeAll(ProviderContinuationRequests.layer, threadManagementProvided, IdAllocator.layer),
  ),
);
const threadTitleRegenerationProvided = ThreadTitleRegenerationService.layer.pipe(
  Layer.provide(Layer.mergeAll(threadManagementProvided, ProjectStore.layer, TextGeneration.layer)),
);
const effectExecutorProvided = EffectWorker.executorLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      runFinalizationServiceProvided,
      checkpointRollbackServiceProvided,
      providerSessionManagerProvided,
      providerTurnControlServiceProvided,
      providerTurnStartServiceProvided,
      runtimeRequestServiceProvided,
      threadTitleRegenerationProvided,
      threadManagementProvided,
    ),
  ),
);
const effectWorkerProvided = EffectWorker.layer.pipe(
  Layer.provide(Layer.merge(storesLayer, effectExecutorProvided)),
);
const providerRuntimeRecoveryProvided = ProviderRuntimeRecoveryService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      effectWorkerProvided,
      storesLayer,
      eventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
    ),
  ),
);

export const OrchestrationV2LayerLive = Layer.mergeAll(
  orchestratorProvided,
  threadManagementProvided,
  effectWorkerProvided,
  providerSessionManagerProvided,
  providerAuthServiceProvided,
  providerRuntimeRecoveryProvided,
  projectionMaintenanceProvided,
  legacyV1ThreadImporterProvided,
);

export const OrchestrationV2ProductionLayerLive = Layer.mergeAll(
  OrchestrationV2LayerLive.pipe(Layer.provide(ProjectServiceLayerLive)),
  ProjectServiceLayerLive,
  managedProjectFoldersProvided,
  threadLaunchProvided,
  threadLifecycleProvided,
  scheduledTaskProvided,
  secretRequestsProvided,
  UsageLimitRecoveryWorker.workerLive.pipe(
    Layer.provide(Layer.mergeAll(ProjectionStore.layer, threadManagementProvided)),
  ),
  providerContinuationWorkerProvided,
  agentSessionImporterProvided,
  EffectOutbox.pruneWorkerLive.pipe(Layer.provide(EffectOutbox.layer)),
).pipe(
  Layer.provide(Scheduler.layer),
  Layer.provideMerge(OrchestrationEventInfrastructureLayerLive),
);
