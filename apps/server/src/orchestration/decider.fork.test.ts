import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-09-03T12:00:00.000Z";
const SOURCE_THREAD_ID = ThreadId.make("thread-source");
const FORK_THREAD_ID = ThreadId.make("thread-fork");
const TURN_ID = TurnId.make("turn-1");
const MESSAGE_ID = MessageId.make("message-1");

function makeReadModel(input?: {
  readonly latestTurnState?: "running" | "interrupted" | "completed" | "error";
  readonly hasLatestTurn?: boolean;
  readonly sourceDeleted?: boolean;
  readonly targetExists?: boolean;
}): OrchestrationReadModel {
  const latestTurnState = input?.latestTurnState ?? "completed";
  const source = {
    id: SOURCE_THREAD_ID,
    projectId: ProjectId.make("project-1"),
    title: "Source thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex-personal"),
      model: "gpt-5.6-sol",
    },
    runtimeMode: "approval-required" as const,
    interactionMode: "plan" as const,
    branch: "feature/source",
    worktreePath: "/tmp/source-worktree",
    latestTurn:
      input?.hasLatestTurn === false
        ? null
        : {
            turnId: TURN_ID,
            state: latestTurnState,
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: latestTurnState === "running" ? null : NOW,
            assistantMessageId: latestTurnState === "running" ? null : MESSAGE_ID,
          },
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: input?.sourceDeleted === true ? NOW : null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
  return {
    snapshotSequence: 1,
    projects: [],
    threads: [source, ...(input?.targetExists === true ? [{ ...source, id: FORK_THREAD_ID }] : [])],
    updatedAt: NOW,
  };
}

const forkCommand = {
  type: "thread.fork" as const,
  commandId: CommandId.make("cmd-fork"),
  threadId: FORK_THREAD_ID,
  sourceThreadId: SOURCE_THREAD_ID,
  sourceMessageId: MESSAGE_ID,
  sideChat: true,
  createdAt: NOW,
};

it.layer(NodeServices.layer)("thread fork decider", (it) => {
  it.effect("inherits source fields and records immutable lineage", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: forkCommand,
        readModel: makeReadModel(),
      });
      const created = Array.isArray(event) ? event[0] : event;
      expect(created?.type).toBe("thread.created");
      if (created?.type !== "thread.created") return;
      expect(created.payload).toMatchObject({
        threadId: FORK_THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Source thread (1)",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex-personal"),
          model: "gpt-5.6-sol",
        },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        branch: "feature/source",
        worktreePath: "/tmp/source-worktree",
        fork: {
          sourceThreadId: SOURCE_THREAD_ID,
          sourceTurnId: TURN_ID,
          sourceMessageId: MESSAGE_ID,
          forkedAt: NOW,
        },
        sideChat: true,
      });
    }),
  );

  it.effect("rejects a source whose latest boundary is still running", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: forkCommand,
        readModel: makeReadModel({ latestTurnState: "running" }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("mid-turn");
    }),
  );

  it.effect("requires an omitted source turn to resolve to a completed latest turn", () =>
    Effect.gen(function* () {
      for (const latestTurnState of ["interrupted", "error"] as const) {
        const error = yield* decideOrchestrationCommand({
          command: forkCommand,
          readModel: makeReadModel({ latestTurnState }),
        }).pipe(Effect.flip);
        expect(error.message).toContain("mid-turn");
      }
    }),
  );

  it.effect("rejects a source message that does not match the resolved latest turn", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          ...forkCommand,
          sourceMessageId: MessageId.make("message-other"),
        },
        readModel: makeReadModel(),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("is not the assistant message");
    }),
  );

  it.effect("allows sources with no turns and explicit older boundaries after restart", () =>
    Effect.gen(function* () {
      const { sourceMessageId: _sourceMessageId, ...forkWithoutMessage } = forkCommand;
      const noTurns = yield* decideOrchestrationCommand({
        command: forkWithoutMessage,
        readModel: makeReadModel({ hasLatestTurn: false }),
      });
      const noTurnsCreated = Array.isArray(noTurns) ? noTurns[0] : noTurns;
      if (noTurnsCreated?.type !== "thread.created") return;
      expect(noTurnsCreated.payload.fork?.sourceTurnId).toBeNull();

      const olderTurnId = TurnId.make("turn-older");
      const older = yield* decideOrchestrationCommand({
        command: { ...forkCommand, sourceTurnId: olderTurnId },
        readModel: makeReadModel(),
      });
      const olderCreated = Array.isArray(older) ? older[0] : older;
      if (olderCreated?.type !== "thread.created") return;
      expect(olderCreated.payload.fork?.sourceTurnId).toBe(olderTurnId);
    }),
  );

  it.effect("rejects deleted sources and existing target ids", () =>
    Effect.gen(function* () {
      const deleted = yield* decideOrchestrationCommand({
        command: forkCommand,
        readModel: makeReadModel({ sourceDeleted: true }),
      }).pipe(Effect.flip);
      expect(deleted.message).toContain("deleted");

      const existing = yield* decideOrchestrationCommand({
        command: forkCommand,
        readModel: makeReadModel({ targetExists: true }),
      }).pipe(Effect.flip);
      expect(existing.message).toContain("already exists");
    }),
  );

  it.effect("allows clearing side chat metadata on any thread", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-promote"),
          threadId: SOURCE_THREAD_ID,
          sideChat: false,
        },
        readModel: makeReadModel(),
      });
      const updated = Array.isArray(event) ? event[0] : event;
      expect(updated?.type).toBe("thread.meta-updated");
      if (updated?.type !== "thread.meta-updated") return;
      expect(updated.payload.sideChat).toBe(false);
    }),
  );

  it.effect("rejects turning an ordinary thread into a side chat", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-hide-ordinary-thread"),
          threadId: SOURCE_THREAD_ID,
          sideChat: true,
        },
        readModel: makeReadModel(),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("is not a fork");
    }),
  );
});
