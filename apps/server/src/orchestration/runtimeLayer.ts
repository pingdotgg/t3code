import { Layer } from "effect";

import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { DelegationAuditRepositoryLive } from "../persistence/Layers/DelegationAudit.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionCheckpointRepositoryLive } from "../persistence/Layers/ProjectionCheckpoints.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionQueuedTurnRepositoryLive } from "../persistence/Layers/ProjectionQueuedTurns.ts";
import { ProjectionStateRepositoryLive } from "../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { ProjectionThreadSessionRepositoryLive } from "../persistence/Layers/ProjectionThreadSessions.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { RepositoryIdentityResolverLive } from "../project/Layers/RepositoryIdentityResolver.ts";
import { ThreadUrlBuilderLive } from "../threadUrl.ts";

export const OrchestrationEventInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
);

export const OrchestrationProjectionPipelineLayerLive = OrchestrationProjectionPipelineLive.pipe(
  Layer.provide(OrchestrationEventStoreLive),
);

export const OrchestrationInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationProjectionSnapshotQueryLive,
  DelegationAuditRepositoryLive,
  OrchestrationEventInfrastructureLayerLive,
  OrchestrationProjectionPipelineLayerLive,
);

export const OrchestrationProjectionSnapshotQueryDependenciesLive = Layer.mergeAll(
  ProjectionCheckpointRepositoryLive,
  ProjectionProjectRepositoryLive,
  ProjectionQueuedTurnRepositoryLive,
  ProjectionStateRepositoryLive,
  ProjectionThreadActivityRepositoryLive,
  ProjectionThreadMessageRepositoryLive,
  ProjectionThreadProposedPlanRepositoryLive,
  ProjectionThreadRepositoryLive,
  ProjectionThreadSessionRepositoryLive,
  RepositoryIdentityResolverLive,
);

export const OrchestrationLayerLive = Layer.mergeAll(
  OrchestrationInfrastructureLayerLive,
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationInfrastructureLayerLive),
    Layer.provide(ThreadUrlBuilderLive),
  ),
);
