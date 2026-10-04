import { Layer } from "effect";

import { CheckpointStoreLive } from "../checkpointing/Layers/CheckpointStore.ts";
import { CheckoutCoordinatorLive } from "../git/CheckoutCoordinator.ts";
import { GitCoreLive } from "../git/Layers/GitCore.ts";
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
    // The engine snapshots source worktrees when forking (workflow workers),
    // so the store is provided here — next to its other dependencies —
    // rather than relying on a distant merge to reach the engine's build
    // environment. The coordinator const is shared with the engine's own
    // internal provision, so both use one lock map.
    Layer.provide(
      CheckpointStoreLive.pipe(Layer.provide(GitCoreLive), Layer.provide(CheckoutCoordinatorLive)),
    ),
  ),
);
