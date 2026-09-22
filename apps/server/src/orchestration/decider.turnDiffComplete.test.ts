import {
  CheckpointRef,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const TURN_ID = TurnId.make("turn-1");

function makeReadModel(checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>) {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints,
        session: null,
      },
    ],
    updatedAt: NOW,
  } satisfies OrchestrationReadModel;
}

function makeCheckpoint(status: OrchestrationCheckpointSummary["status"]) {
  return {
    turnId: TURN_ID,
    checkpointTurnCount: 1,
    checkpointRef: CheckpointRef.make(`existing:${status}`),
    status,
    files: [],
    assistantMessageId: null,
    completedAt: NOW,
  } satisfies OrchestrationCheckpointSummary;
}

function placeholderCommand() {
  return {
    type: "thread.turn.diff.complete",
    commandId: CommandId.make("cmd-diff-placeholder"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    completedAt: NOW,
    checkpointRef: CheckpointRef.make("provider-diff:event-1"),
    status: "missing",
    files: [],
    assistantMessageId: MessageId.make("assistant:turn-1"),
    checkpointTurnCount: 2,
    createdAt: NOW,
  } as const;
}

it.layer(NodeServices.layer)("turn diff complete decider", (it) => {
  it.effect("rejects a placeholder when the turn already has a captured checkpoint", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          command: placeholderCommand(),
          readModel: makeReadModel([makeCheckpoint("ready")]),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("accepts a placeholder when the turn only has a placeholder", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: placeholderCommand(),
        readModel: makeReadModel([makeCheckpoint("missing")]),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.turn-diff-completed");
    }),
  );

  it.effect("lets a captured checkpoint replace an earlier placeholder", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          ...placeholderCommand(),
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/turn-1"),
          status: "ready",
        },
        readModel: makeReadModel([makeCheckpoint("missing")]),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.turn-diff-completed");
    }),
  );
});
