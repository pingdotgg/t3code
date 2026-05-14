import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnQueueItemId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { QueuedTurnDrainReactor } from "../Services/QueuedTurnDrainReactor.ts";
import { QueuedTurnDrainReactorLive } from "./QueuedTurnDrainReactor.ts";

const now = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");

function makeSnapshot(input: {
  readonly sessionStatus: "ready" | "running";
  readonly queuedStatus?: "pending" | "sending";
  readonly queuedStatuses?: ReadonlyArray<"pending" | "sending">;
}): OrchestrationReadModel {
  const queuedStatuses = input.queuedStatuses ?? [input.queuedStatus ?? "pending"];
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        queuedTurns: queuedStatuses.map((status, index) => ({
          queueItemId: TurnQueueItemId.make(`queue-item-${index + 1}`),
          messageId: MessageId.make(`message-${index + 1}`),
          runtimeMode: "full-access",
          interactionMode: "default",
          status,
          failureReason: null,
          createdAt: now,
          updatedAt: now,
        })),
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: {
          threadId,
          status: input.sessionStatus,
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
      },
    ],
    updatedAt: now,
  };
}

function makeLayer(snapshot: OrchestrationReadModel, dispatched: OrchestrationCommand[]) {
  return QueuedTurnDrainReactorLive.pipe(
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(snapshot),
        getSnapshot: () => Effect.die("getSnapshot should not be called"),
        getShellSnapshot: () => Effect.die("getShellSnapshot should not be called"),
        getArchivedShellSnapshot: () => Effect.die("getArchivedShellSnapshot should not be called"),
        getActiveProjectByWorkspaceRoot: () =>
          Effect.die("getActiveProjectByWorkspaceRoot should not be called"),
        getProjectShellById: () => Effect.die("getProjectShellById should not be called"),
        getFirstActiveThreadIdByProjectId: () =>
          Effect.die("getFirstActiveThreadIdByProjectId should not be called"),
        getThreadDetailById: () => Effect.die("getThreadDetailById should not be called"),
        getThreadCheckpointContext: () =>
          Effect.die("getThreadCheckpointContext should not be called"),
        getFullThreadDiffContext: () => Effect.die("getFullThreadDiffContext should not be called"),
        getThreadShellById: () => Effect.die("getThreadShellById should not be called"),
        getCounts: () => Effect.die("getCounts should not be called"),
        getSnapshotSequence: () => Effect.die("getSnapshotSequence should not be called"),
      }),
    ),
  );
}

describe("QueuedTurnDrainReactor", () => {
  it("claims pending queued turns when a thread is ready", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const runtime = ManagedRuntime.make(
      makeLayer(makeSnapshot({ sessionStatus: "ready", queuedStatus: "pending" }), dispatched),
    );
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const reactor = await runtime.runPromise(Effect.service(QueuedTurnDrainReactor));
      await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: "thread.queued-turn.send.start",
        threadId,
        mode: "normal",
      });
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    }
  });

  it("does not claim queued turns while the thread is running", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const runtime = ManagedRuntime.make(
      makeLayer(makeSnapshot({ sessionStatus: "running", queuedStatus: "pending" }), dispatched),
    );
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const reactor = await runtime.runPromise(Effect.service(QueuedTurnDrainReactor));
      await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
      expect(dispatched).toHaveLength(0);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    }
  });

  it("recovers sending queued turns on startup", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const runtime = ManagedRuntime.make(
      makeLayer(makeSnapshot({ sessionStatus: "ready", queuedStatus: "sending" }), dispatched),
    );
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const reactor = await runtime.runPromise(Effect.service(QueuedTurnDrainReactor));
      await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
      expect(dispatched[0]).toMatchObject({
        type: "thread.queued-turn.send.start",
        mode: "recover",
      });
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    }
  });

  it("does not normal-drain a thread after recovering a sending queued turn on startup", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const runtime = ManagedRuntime.make(
      makeLayer(
        makeSnapshot({
          sessionStatus: "ready",
          queuedStatuses: ["sending", "pending"],
        }),
        dispatched,
      ),
    );
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const reactor = await runtime.runPromise(Effect.service(QueuedTurnDrainReactor));
      await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: "thread.queued-turn.send.start",
        mode: "recover",
      });
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    }
  });
});
