import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";

const TestLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-operator-projection-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)("Operator projections", (it) => {
  it.effect(
    "round-trips coordinator workspace and child ownership through durable projections",
    () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const query = yield* ProjectionSnapshotQuery;
        const projectId = ProjectId.make("operator-project");
        const coordinatorId = ThreadId.make("operator-coordinator");
        const childId = ThreadId.make("operator-child");
        const modelSelection = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        } as const;
        const createdAt = "2026-08-12T10:00:00.000Z";
        const waitStartedAt = "2026-08-12T10:01:00.000Z";

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("operator-project-create"),
          projectId,
          title: "Operator Project",
          workspaceRoot: "/projects/operator",
          defaultModelSelection: modelSelection,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("operator-coordinator-create"),
          threadId: coordinatorId,
          projectId,
          title: "Coordinator",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feat/operator",
          worktreePath: "/worktrees/operator",
          createdAt,
        });
        const freshCoordinator = Option.getOrThrow(yield* query.getThreadDetailById(coordinatorId));
        assert.equal(freshCoordinator.operatorParentThreadId, null);
        assert.equal(freshCoordinator.operatorBatchId, null);
        assert.equal(freshCoordinator.operatorWorkspacePath, null);
        assert.equal(freshCoordinator.operatorWorkspaceBranch, null);
        assert.equal(freshCoordinator.operatorWaitStartedAt, null);
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("operator-coordinator-workspace"),
          threadId: coordinatorId,
          operatorWorkspacePath: "/worktrees/shared-operator",
          operatorWorkspaceBranch: "feat/shared-operator",
          operatorWaitStartedAt: waitStartedAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("operator-child-create"),
          threadId: childId,
          projectId,
          title: "Frontend",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feat/shared-operator",
          worktreePath: "/worktrees/shared-operator",
          operatorParentThreadId: coordinatorId,
          operatorBatchId: "batch-1",
          createdAt,
        });

        const coordinator = Option.getOrThrow(yield* query.getThreadDetailById(coordinatorId));
        const child = Option.getOrThrow(yield* query.getThreadShellById(childId));

        assert.equal(coordinator.operatorWorkspacePath, "/worktrees/shared-operator");
        assert.equal(coordinator.operatorWorkspaceBranch, "feat/shared-operator");
        assert.equal(coordinator.operatorWaitStartedAt, waitStartedAt);
        assert.equal(child.operatorParentThreadId, coordinatorId);
        assert.equal(child.operatorBatchId, "batch-1");
        assert.equal(child.worktreePath, "/worktrees/shared-operator");

        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("operator-coordinator-wait-finished"),
          threadId: coordinatorId,
          operatorWaitStartedAt: null,
        });
        const resumedCoordinator = Option.getOrThrow(
          yield* query.getThreadShellById(coordinatorId),
        );
        assert.equal(resumedCoordinator.operatorWaitStartedAt, null);
      }),
  );
});
