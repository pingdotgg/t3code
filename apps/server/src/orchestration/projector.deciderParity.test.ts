import {
  CheckpointRef,
  CommandId,
  EventId,
  isImportedAgentSessionMessageId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCheckpointFile,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const BASE = DateTime.makeUnsafe("2026-03-01T12:00:00.000Z");
const at = (second: number) => DateTime.formatIso(DateTime.add(BASE, { seconds: second }));
const THREAD = ThreadId.make("thread-parity");
const IMPORTED = ThreadId.make("import:codex:parity");

function threadEvent(
  threadId: ThreadId,
  type: OrchestrationEvent["type"],
  second: number,
  payload: object,
): OrchestrationEvent {
  return {
    sequence: 0,
    eventId: EventId.make(`${threadId}:${type}:${second}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    type,
    occurredAt: at(second),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: { threadId, ...payload },
  } as OrchestrationEvent;
}

const created = (threadId: ThreadId) =>
  threadEvent(threadId, "thread.created", 0, {
    projectId: ProjectId.make("project-1"),
    title: "Parity",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: at(0),
    updatedAt: at(0),
  });
const message = (
  second: number,
  messageId: string,
  role: "user" | "assistant",
  turnId: string | null,
  text: string,
  streaming = false,
  threadId = THREAD,
) =>
  threadEvent(threadId, "thread.message-sent", second, {
    messageId,
    role,
    text,
    turnId,
    streaming,
    createdAt: at(second),
    updatedAt: at(second),
  });
const activity = (
  second: number,
  id: string,
  kind: string,
  turnId: string | null,
  payload: object,
) =>
  threadEvent(THREAD, "thread.activity-appended", second, {
    activity: { id, tone: "info", kind, summary: kind, payload, turnId, createdAt: at(second) },
  });
const session = (second: number, status: "running" | "ready" | "stopped", activeTurnId?: string) =>
  threadEvent(THREAD, "thread.session-set", second, {
    session: {
      threadId: THREAD,
      status,
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: activeTurnId ?? null,
      lastError: null,
      updatedAt: at(second),
    },
  });
const checkpoint = (second: number, turn: number) =>
  threadEvent(THREAD, "thread.turn-diff-completed", second, {
    turnId: `turn-${turn}`,
    checkpointTurnCount: turn,
    checkpointRef: `refs/t3/checkpoints/thread-parity/turn/${turn}`,
    status: "ready",
    files: [{ path: "src/app.ts", kind: "modified", additions: 3, deletions: 1 }],
    assistantMessageId: `assistant:${turn}`,
    completedAt: at(second),
  });

// A realistic life of one thread, plus one imported thread, split into
// stages. The decider runs after each stage.
const stages: ReadonlyArray<ReadonlyArray<OrchestrationEvent>> = [
  // 1. Turn 1 streams, runs tools, and waits on an approval.
  [
    created(THREAD),
    created(IMPORTED),
    message(1, "user-1", "user", null, "Fix the login bug"),
    session(2, "running", "turn-1"),
    message(3, "assistant:1", "assistant", "turn-1", "Looking", true),
    message(4, "assistant:1", "assistant", "turn-1", " at it", true),
    message(5, "assistant:1", "assistant", "turn-1", "", false),
    activity(6, "tool-1", "tool.started", "turn-1", { toolKind: "command" }),
    activity(7, "tool-2", "tool.completed", "turn-1", { data: { output: "x".repeat(2_000) } }),
    activity(8, "approval-1", "approval.requested", "turn-1", { requestId: "approval-1" }),
  ],
  // 2. The approval is answered, a callback question is asked and answered,
  // and turn 1 completes. The imported thread gets assistant-only history.
  [
    activity(9, "approval-1-done", "approval.resolved", "turn-1", {
      requestId: "approval-1",
      decision: "accept",
    }),
    activity(10, "question-1", "user-input.requested", "turn-1", { requestId: "question-1" }),
    activity(11, "question-1-answer", "user-input.answer-submitted", "turn-1", {
      requestId: "question-1",
      answers: { q1: "yes" },
    }),
    activity(12, "question-1-done", "user-input.resolved", "turn-1", { requestId: "question-1" }),
    checkpoint(13, 1),
    session(14, "ready"),
    message(15, `${IMPORTED}:000000`, "assistant", null, "Imported answer", false, IMPORTED),
  ],
  // 3. Turn 2 stops with an async question and an approval whose reply failed.
  [
    message(20, "user-2", "user", null, "Now add a test"),
    session(21, "running", "turn-2"),
    message(22, "assistant:2", "assistant", "turn-2", "Adding a test"),
    activity(23, "tool-3", "tool.completed", "turn-2", { data: { output: "ok" } }),
    activity(24, "question-2", "user-input.requested", "turn-2", {
      requestId: "question-2",
      responseMode: "message",
    }),
    activity(25, "approval-2", "approval.requested", "turn-2", { requestId: "approval-2" }),
    activity(26, "approval-2-failed", "provider.approval.respond.failed", null, {
      requestId: "approval-2",
      detail: "No active provider session is bound to this thread.",
    }),
    checkpoint(27, 2),
    session(28, "stopped"),
  ],
  // 4. A stale reply clears the approval. The async question stays open.
  [
    activity(30, "approval-2-stale", "provider.approval.respond.failed", null, {
      requestId: "approval-2",
      detail: "Stale pending approval request: approval-2",
    }),
  ],
  // 5. Revert to turn 1, then a bootstrap message waits for its turn.
  [
    threadEvent(THREAD, "thread.reverted", 40, { turnCount: 1 }),
    message(990, "user-3", "user", null, "Try again"),
  ],
];

// Rebuilds the full history the command projector used to keep: every
// non-user message with its text, every activity, and checkpoint file lists,
// with a revert dropping what belonged to the reverted turns. User messages
// come from the slim model, which still keeps all of them. The timeline stays
// under the old caps, and every non-user message has a turn id or an imported
// id, so the old caps and revert fallbacks never apply.
function fullHistoryThread(
  thread: OrchestrationThread,
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationThread {
  let messages: OrchestrationMessage[] = [];
  let activities: Array<OrchestrationThread["activities"][number]> = [];
  const files = new Map<string, ReadonlyArray<OrchestrationCheckpointFile>>();
  const turnCounts = new Map<string, number>();
  for (const event of events) {
    if (event.aggregateId !== thread.id) continue;
    if (event.type === "thread.message-sent" && event.payload.role !== "user") {
      const { payload } = event;
      const existing = messages.find((entry) => entry.id === payload.messageId);
      const next: OrchestrationMessage = {
        id: payload.messageId,
        role: payload.role,
        text: payload.streaming
          ? `${existing?.text ?? ""}${payload.text}`
          : payload.text || (existing?.text ?? ""),
        turnId: payload.turnId,
        streaming: payload.streaming,
        createdAt: existing?.createdAt ?? payload.createdAt,
        updatedAt: payload.updatedAt,
      };
      messages = existing
        ? messages.map((entry) => (entry === existing ? next : entry))
        : [...messages, next];
    } else if (event.type === "thread.activity-appended") {
      const { activity: appended } = event.payload;
      activities = [...activities.filter((entry) => entry.id !== appended.id), appended];
    } else if (event.type === "thread.turn-diff-completed") {
      files.set(event.payload.turnId, event.payload.files);
      turnCounts.set(event.payload.turnId, event.payload.checkpointTurnCount);
    } else if (event.type === "thread.reverted") {
      const { turnCount } = event.payload;
      const kept = (turnId: string | null) =>
        turnId !== null && (turnCounts.get(turnId) ?? Number.POSITIVE_INFINITY) <= turnCount;
      messages = messages.filter(
        (entry) => isImportedAgentSessionMessageId(entry.id) || kept(entry.turnId),
      );
      activities = activities.filter((entry) => entry.turnId === null || kept(entry.turnId));
    }
  }
  return {
    ...thread,
    messages: [...thread.messages.filter((entry) => entry.role === "user"), ...messages],
    activities,
    checkpoints: thread.checkpoints.map((entry) => ({
      ...entry,
      files: files.get(entry.turnId) ?? [],
    })),
  };
}

const commands: ReadonlyArray<readonly [string, OrchestrationCommand]> = [
  ["settle", { type: "thread.settle", commandId: CommandId.make("settle"), threadId: THREAD }],
  [
    "auto-settle",
    {
      type: "thread.auto-settle",
      commandId: CommandId.make("auto-settle"),
      threadId: THREAD,
      snapshotSequence: 0,
      settledAt: at(500),
    },
  ],
  [
    "snooze",
    {
      type: "thread.snooze",
      commandId: CommandId.make("snooze"),
      threadId: THREAD,
      snoozedUntil: at(100_000),
    },
  ],
  ...(["user-1", "user-2"] as const).map(
    (messageId) =>
      [
        `append ${messageId}`,
        {
          type: "thread.message.user.append",
          commandId: CommandId.make(`append-${messageId}`),
          threadId: THREAD,
          message: { messageId: MessageId.make(messageId), text: "Again", attachments: [] },
          createdAt: at(995),
        },
      ] as const,
  ),
  [
    "turn start user-3",
    {
      type: "thread.turn.start",
      commandId: CommandId.make("turn-start"),
      threadId: THREAD,
      message: {
        messageId: MessageId.make("user-3"),
        role: "user",
        text: "Try again",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: at(995),
    },
  ],
  ...([1, 2] as const).map(
    (turn) =>
      [
        `missing diff turn-${turn}`,
        {
          type: "thread.turn.diff.complete",
          commandId: CommandId.make(`missing-diff-${turn}`),
          threadId: THREAD,
          turnId: TurnId.make(`turn-${turn}`),
          completedAt: at(995),
          checkpointRef: CheckpointRef.make(`provider-diff:${turn}`),
          status: "missing",
          files: [],
          checkpointTurnCount: turn,
          createdAt: at(995),
        },
      ] as const,
  ),
  [
    "import",
    {
      type: "thread.history.import",
      commandId: CommandId.make("import"),
      threadId: IMPORTED,
      messages: [
        {
          messageId: MessageId.make(`${IMPORTED}:000001`),
          role: "user",
          text: "Imported question",
          createdAt: at(995),
        },
      ],
    },
  ],
];

// The decided events without their random ids, or the rejection.
const decide = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.map((result) =>
      (Array.isArray(result) ? result : [result]).map(
        ({ eventId: _eventId, causationEventId: _causationEventId, ...event }) => event,
      ),
    ),
    Effect.catch((error) => Effect.succeed({ rejected: error._tag, message: error.message })),
  );

const outcomeNames: Record<string, string> = {
  OrchestrationThreadSettleBlockedError: "blocked",
  OrchestrationCommandInvariantError: "rejected",
};

it.layer(NodeServices.layer)("command model decider parity", (it) => {
  // The command projector drops non-user messages, non-request activities, and
  // checkpoint file lists. After each stage, the decider must decide every
  // command the same way on that slim model as on the full history.
  it.effect("decides the same on the slim command model as on full history", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(BASE, { seconds: 1_000 })));
      let slim = createEmptyReadModel(at(0));
      const seen: OrchestrationEvent[] = [];
      const summaries: string[] = [];
      for (const stage of stages) {
        for (const event of stage) {
          seen.push({ ...event, sequence: seen.length + 1 });
          slim = yield* projectEvent(slim, seen[seen.length - 1]!);
        }
        const full = {
          ...slim,
          threads: slim.threads.map((thread) => fullHistoryThread(thread, seen)),
        };
        const results: string[] = [];
        for (const [label, command] of commands) {
          const onSlim = yield* decide(slim, command);
          expect(onSlim, label).toEqual(yield* decide(full, command));
          results.push(`${label}: ${"rejected" in onSlim ? outcomeNames[onSlim.rejected] : "ok"}`);
        }
        summaries.push(results.join(", "));
      }

      // Most commands are accepted at one stage and rejected at another, so the
      // comparison above is not vacuous.
      expect(summaries).toMatchInlineSnapshot(`
        [
          "settle: blocked, auto-settle: blocked, snooze: rejected, append user-1: rejected, append user-2: ok, turn start user-3: ok, missing diff turn-1: ok, missing diff turn-2: ok, import: ok",
          "settle: ok, auto-settle: ok, snooze: ok, append user-1: rejected, append user-2: ok, turn start user-3: ok, missing diff turn-1: rejected, missing diff turn-2: ok, import: rejected",
          "settle: blocked, auto-settle: blocked, snooze: rejected, append user-1: rejected, append user-2: rejected, turn start user-3: ok, missing diff turn-1: rejected, missing diff turn-2: rejected, import: rejected",
          "settle: ok, auto-settle: blocked, snooze: rejected, append user-1: rejected, append user-2: rejected, turn start user-3: ok, missing diff turn-1: rejected, missing diff turn-2: rejected, import: rejected",
          "settle: blocked, auto-settle: blocked, snooze: rejected, append user-1: rejected, append user-2: ok, turn start user-3: ok, missing diff turn-1: rejected, missing diff turn-2: ok, import: rejected",
        ]
      `);
    }),
  );
});
