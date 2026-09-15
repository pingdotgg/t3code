import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  type OrchestrationCommand,
  ThreadId,
  WORKTREE_SETUP_ACTIVITY_KIND,
  WorktreeSetupSnapshot,
  worktreeSetupActivityId,
  type WorktreeSetupPhase,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

const startedAt = "2026-08-20T12:00:00.000Z";

const snapshotFor = (threadId: ThreadId, phase: WorktreeSetupPhase): WorktreeSetupSnapshot => ({
  threadId,
  phase,
  startedAt,
  endedAt: phase === "running" ? null : startedAt,
  branch: "feature",
  baseRef: "main",
  worktreePath: null,
  setupScript: null,
  stages: [
    {
      id: "checkout",
      status: "done",
      startedAt,
      endedAt: startedAt,
      percent: null,
      detail: null,
      tail: [],
    },
    {
      id: "setup-script",
      status: phase === "running" ? "running" : "done",
      startedAt,
      endedAt: phase === "running" ? null : startedAt,
      percent: null,
      detail: null,
      tail: [],
    },
    {
      id: "agent",
      status: phase === "running" ? "pending" : "done",
      startedAt: null,
      endedAt: null,
      percent: null,
      detail: null,
      tail: [],
    },
  ],
  error: null,
  sequence: 4,
});

const makeThread = (
  id: string,
  phase: WorktreeSetupPhase | null,
  deletedAt: string | null = null,
) => {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    deletedAt,
    activities:
      phase === null
        ? []
        : [
            {
              id: EventId.make(worktreeSetupActivityId(threadId)),
              tone: "info" as const,
              kind: WORKTREE_SETUP_ACTIVITY_KIND,
              summary: "Setting up worktree",
              payload: snapshotFor(threadId, phase),
              turnId: null,
              createdAt: startedAt,
            },
          ],
  };
};

const run = (threads: ReadonlyArray<ReturnType<typeof makeThread>>) =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];
    yield* ServerRuntimeStartup.reconcileWorktreeSetups.pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed({ threads } as never),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused"),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      }),
      Effect.provide(NodeServices.layer),
    );
    return dispatched;
  });

it.effect("marks setups still recorded as running failed after a restart", () =>
  Effect.gen(function* () {
    const dispatched = yield* run([
      makeThread("thread-running", "running"),
      makeThread("thread-done", "done"),
      makeThread("thread-none", null),
      makeThread("thread-deleted", "running", startedAt),
    ]);

    assert.equal(dispatched.length, 1);
    const command = dispatched[0]!;
    assert.equal(command.type, "thread.activity.append");
    if (command.type !== "thread.activity.append") return;
    assert.equal(command.threadId, ThreadId.make("thread-running"));
    assert.equal(command.activity.id, worktreeSetupActivityId(ThreadId.make("thread-running")));
    assert.equal(command.activity.tone, "error");
    const payload = yield* Schema.decodeUnknownEffect(WorktreeSetupSnapshot)(
      command.activity.payload,
    );
    assert.equal(payload.phase, "failed");
    assert.isNotNull(payload.endedAt);
    assert.equal(payload.sequence, 5);
    assert.deepEqual(
      payload.stages.map((stage) => stage.status),
      ["done", "failed", "failed"],
    );
  }),
);
