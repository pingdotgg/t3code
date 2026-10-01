import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import {
  ProjectionPendingApprovalRepository,
  type ProjectionPendingApprovalRepositoryShape,
} from "../../persistence/Services/ProjectionPendingApprovals.ts";
import {
  ProjectionReconciliationJobRepository,
  type ProjectionReconciliationJobRepositoryShape,
} from "../../persistence/Services/ProjectionReconciliationJobs.ts";
import {
  ProjectionThreadActivityRepository,
  type ProjectionThreadActivityRepositoryShape,
} from "../../persistence/Services/ProjectionThreadActivities.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessageRepositoryShape,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  ProjectionThreadProposedPlanRepository,
  type ProjectionThreadProposedPlanRepositoryShape,
} from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
  type ProjectionThreadRepositoryShape,
} from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionReconciler, ProjectionReconcilerLive } from "./ProjectionReconciler.ts";

const timestamp = "2026-09-30T00:00:00.000Z";

const reconciliationJobs: ProjectionReconciliationJobRepositoryShape = {
  enqueue: () => Effect.void,
  listPending: () =>
    Effect.succeed([
      {
        sequence: 1,
        shellThreadIds: Array.from({ length: 6 }, (_, index) =>
          ThreadId.make(`thread-${index + 1}`),
        ),
        attachmentThreadIds: [],
        createdAt: timestamp,
      },
    ]),
  completeThrough: () => Effect.void,
};

const threadFor = (threadId: ThreadId): ProjectionThread =>
  ({
    threadId,
    projectId: ProjectId.make("project-one"),
    title: "Thread",
    modelSelection: { instanceId: "codex", model: "gpt-5" } as ProjectionThread["modelSelection"],
    runtimeMode: "full-access",
    pendingRuntimeMode: null,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequest: null,
    latestTurnId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    latestUserMessageAt: null,
    latestChildNotificationAt: null,
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
    hasActionableProposedPlan: 0,
    deletedAt: null,
  }) as ProjectionThread;

const makeTestLayer = (maxConcurrentThreadReads: { value: number }) => {
  let activeThreadReads = 0;
  const threadRepository: ProjectionThreadRepositoryShape = {
    getById: ({ threadId }) =>
      Effect.promise(async () => {
        activeThreadReads += 1;
        maxConcurrentThreadReads.value = Math.max(
          maxConcurrentThreadReads.value,
          activeThreadReads,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeThreadReads -= 1;
        return Option.some(threadFor(threadId));
      }),
    upsert: () => Effect.void,
    listByProjectId: () => Effect.succeed([]),
    deleteById: () => Effect.void,
  };

  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "projection-reconciler-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    Layer.succeed(ProjectionReconciliationJobRepository, reconciliationJobs),
    Layer.succeed(ProjectionThreadRepository, threadRepository),
    Layer.succeed(ProjectionThreadMessageRepository, {
      getLatestUserMessageAt: () => Effect.succeed(null),
    } as unknown as ProjectionThreadMessageRepositoryShape),
    Layer.succeed(ProjectionPendingApprovalRepository, {
      countPendingByThreadId: () => Effect.succeed(0),
    } as unknown as ProjectionPendingApprovalRepositoryShape),
    Layer.succeed(ProjectionThreadActivityRepository, {
      listUserInputLifecycleByThreadId: () => Effect.succeed([]),
    } as unknown as ProjectionThreadActivityRepositoryShape),
    Layer.succeed(ProjectionThreadProposedPlanRepository, {
      listSummariesByThreadId: () => Effect.succeed([]),
    } as unknown as ProjectionThreadProposedPlanRepositoryShape),
  );

  return ProjectionReconcilerLive.pipe(Layer.provideMerge(dependencies));
};

const maxConcurrentThreadReads = { value: 0 };
const projectionReconcilerLayer = it.layer(makeTestLayer(maxConcurrentThreadReads));

projectionReconcilerLayer("ProjectionReconciler", (it) => {
  it.effect("refreshes shell summaries with bounded concurrency", () =>
    Effect.gen(function* () {
      const reconciler = yield* ProjectionReconciler;
      maxConcurrentThreadReads.value = 0;
      yield* reconciler.drain;
      expect(maxConcurrentThreadReads.value).toBe(4);
    }),
  );
});
