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
import * as Predicate from "effect/Predicate";
import * as TestClock from "effect/testing/TestClock";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, openRequests, projectEvent } from "./projector.ts";

const BASE = DateTime.makeUnsafe("2026-03-01T12:00:00.000Z");
const at = (second: number) =>
  DateTime.formatIso(DateTime.add(BASE, { milliseconds: Math.round(second * 1_000) }));
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
// Tool output that arrives while turn 3 waits on the user.
const toolRun = (firstSecond: number, first: number, count: number) =>
  Array.from({ length: count }, (_, index) =>
    activity(
      firstSecond + index / 1_000,
      `tool-3-${String(first + index).padStart(3, "0")}`,
      "tool.completed",
      "turn-3",
      { data: { output: "ok" } },
    ),
  );
const checkpoint = (second: number, turn: number, turnId = `turn-${turn}`) =>
  threadEvent(THREAD, "thread.turn-diff-completed", second, {
    turnId,
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
  // 6. Turn 3 asks an async question and waits on an approval while 499 more
  // activities arrive. The old 500 activity cap still holds the approval.
  [
    session(991, "running", "turn-3"),
    ...toolRun(991.1, 0, 3),
    activity(992, "question-3", "user-input.requested", "turn-3", {
      requestId: "question-3",
      responseMode: "message",
    }),
    activity(992.5, "approval-3", "approval.requested", "turn-3", { requestId: "approval-3" }),
    ...toolRun(993, 3, 499),
    session(996, "ready"),
  ],
  // 7. One more activity pushes the approval out of the old cap. The pending
  // async question stays past the cap.
  [...toolRun(997, 502, 1)],
];

type Activity = OrchestrationThread["activities"][number];

// The old command projector's activity cap: the most recent 500 activities,
// plus pending async questions.
function capActivities(activities: ReadonlyArray<Activity>) {
  const recentStart = activities.length - 500;
  if (recentStart <= 0) return activities;
  const pending = new Map<string, Activity>();
  for (const entry of activities) {
    if (!Predicate.isObject(entry.payload)) continue;
    const { requestId } = entry.payload;
    if (typeof requestId !== "string") continue;
    if (entry.kind === "user-input.requested" && entry.payload.responseMode === "message") {
      pending.set(requestId, entry);
    } else if (entry.kind === "user-input.resolved") {
      pending.delete(requestId);
    }
  }
  const pinned = new Set(pending.values());
  return activities.filter((entry, index) => index >= recentStart || pinned.has(entry));
}

// The history the command projector used to keep for one thread: every
// non-user message with its text, every activity under the old cap, and
// checkpoint file lists, with a revert dropping what belonged to the reverted
// turns. The timelines here stay under the message and checkpoint caps, and
// every non-user message has a turn id or an imported id, so the old message
// caps and revert fallbacks never apply.
interface FullHistory {
  messages: ReadonlyArray<OrchestrationMessage>;
  activities: ReadonlyArray<Activity>;
  readonly files: Map<string, ReadonlyArray<OrchestrationCheckpointFile>>;
  readonly turnCounts: Map<string, number>;
}

// Adds one event to the full history of its thread, keyed by thread id.
function recordEvent(histories: Map<string, FullHistory>, event: OrchestrationEvent) {
  let history = histories.get(event.aggregateId);
  if (history === undefined) {
    history = { messages: [], activities: [], files: new Map(), turnCounts: new Map() };
    histories.set(event.aggregateId, history);
  }
  if (event.type === "thread.message-sent" && event.payload.role !== "user") {
    const { payload } = event;
    const existing = history.messages.find((entry) => entry.id === payload.messageId);
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
    history.messages = existing
      ? history.messages.map((entry) => (entry === existing ? next : entry))
      : [...history.messages, next];
  } else if (event.type === "thread.activity-appended") {
    const { activity: appended } = event.payload;
    history.activities = capActivities(
      [...history.activities.filter((entry) => entry.id !== appended.id), appended].toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      ),
    );
  } else if (event.type === "thread.turn-diff-completed") {
    history.files.set(event.payload.turnId, event.payload.files);
    history.turnCounts.set(event.payload.turnId, event.payload.checkpointTurnCount);
  } else if (event.type === "thread.reverted") {
    const { turnCount } = event.payload;
    const { turnCounts } = history;
    const kept = (turnId: string | null) =>
      turnId !== null && (turnCounts.get(turnId) ?? Number.POSITIVE_INFINITY) <= turnCount;
    history.messages = history.messages.filter(
      (entry) => isImportedAgentSessionMessageId(entry.id) || kept(entry.turnId),
    );
    history.activities = history.activities.filter(
      (entry) => entry.turnId === null || kept(entry.turnId),
    );
  }
}

// The slim thread with its full history put back. User messages come from
// the slim model, which still keeps all of them.
function fullHistoryThread(thread: OrchestrationThread, history: FullHistory): OrchestrationThread {
  return {
    ...thread,
    messages: [...thread.messages.filter((entry) => entry.role === "user"), ...history.messages],
    activities: history.activities,
    checkpoints: thread.checkpoints.map((entry) => ({
      ...entry,
      files: history.files.get(entry.turnId) ?? [],
    })),
  };
}

// Failure details that mark a request stale or unknown.
const STALE_DETAILS = [
  "stale pending approval request",
  "unknown pending approval request",
  "unknown pending permission request",
  "stale pending user-input request",
  "unknown pending user-input request",
  "unknown pending user input request",
  "unknown pending codex user input request",
];

// openRequests as main's decider wrote it, before REQUEST_ACTIVITY_ROLES.
function mainOpenRequests(activities: ReadonlyArray<Activity>) {
  const requests = new Map<string, Activity>();
  for (const activity of activities) {
    if (!Predicate.isObject(activity.payload)) continue;
    const { requestId, detail } = activity.payload;
    if (typeof requestId !== "string") continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      requests.set(requestId, activity);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      requests.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      typeof detail === "string" &&
      STALE_DETAILS.some((stale) => detail.toLowerCase().includes(stale))
    ) {
      requests.delete(requestId);
    }
  }
  return requests;
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

// A tiny seeded PRNG (mulberry32), so each seed replays the same timeline.
function prng(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32;
  };
}

// A random life of THREAD in `steps` steps: request opens (approval, native
// callback, async question), resolves, stale and non-stale respond failures,
// tool activity, assistant and user messages, checkpoints, and reverts. Most
// steps are one event. A tool burst is 100 to 600 events, so the 500 activity
// cap closes some open requests. As in the decider and the adapters, a
// resolve has the turn id of its request.
//
// Two known differences stay out. Time only moves forward. A stale failure
// never targets an async question: on main, the cap keeps the question but
// drops the failure after 500 activities, so the question opens again. The
// slim model counts fewer activities, so the question opens again later or
// never.
function randomTimeline(seed: number, steps: number): OrchestrationEvent[] {
  const random = prng(seed);
  const pick = <T>(items: ReadonlyArray<T>) => items[Math.floor(random() * items.length)]!;
  let tick = 0;
  const now = () => ++tick / 1_000;
  let turnCount = 1;
  let turnId = "turn-1";
  type Request = {
    readonly requestId: string;
    readonly kind: "approval" | "callback" | "question";
    readonly turnId: string;
  };
  const issued: Request[] = [];
  const open = new Set<Request>();
  // Mostly a request the generator thinks is open, sometimes any request.
  const target = () => (open.size > 0 && random() < 0.8 ? pick([...open]) : pick(issued));

  const tool = () =>
    activity(now(), `tool-${tick}`, pick(["tool.started", "tool.completed"]), turnId, {
      data: { output: "ok" },
    });
  const request = (kind: Request["kind"]) => {
    const second = now();
    const entry = { requestId: `request-${tick}`, kind, turnId };
    issued.push(entry);
    open.add(entry);
    const { requestId } = entry;
    const payload = kind === "question" ? { requestId, responseMode: "message" } : { requestId };
    const opened = kind === "approval" ? "approval.requested" : "user-input.requested";
    return [activity(second, requestId, opened, turnId, payload)];
  };
  const resolve = () => {
    if (issued.length === 0) return [tool()];
    const entry = target();
    open.delete(entry);
    const kind = entry.kind === "approval" ? "approval.resolved" : "user-input.resolved";
    const { requestId } = entry;
    return [activity(now(), `resolved-${tick}`, kind, entry.turnId, { requestId })];
  };
  const fail = () => {
    if (issued.length === 0) return [tool()];
    const entry = target();
    const phrase = pick(STALE_DETAILS);
    const stale = entry.kind !== "question" && random() < 0.5;
    if (stale) open.delete(entry);
    const detail = stale
      ? `${phrase[0]!.toUpperCase()}${phrase.slice(1)}: ${entry.requestId}`
      : "No active provider session is bound to this thread.";
    const kind =
      entry.kind === "approval"
        ? "provider.approval.respond.failed"
        : "provider.user-input.respond.failed";
    return [activity(now(), `failed-${tick}`, kind, null, { requestId: entry.requestId, detail })];
  };
  const completeTurn = () => {
    const event = checkpoint(now(), turnCount, turnId);
    turnCount += 1;
    turnId = `turn-${tick}`;
    return [event];
  };
  const revert = () => {
    const kept = Math.floor(random() * turnCount);
    const event = threadEvent(THREAD, "thread.reverted", now(), { turnCount: kept });
    turnCount = kept + 1;
    turnId = `turn-${tick}`;
    return [event];
  };

  const actions: ReadonlyArray<readonly [number, () => ReadonlyArray<OrchestrationEvent>]> = [
    [30, () => [tool()]],
    [2, () => Array.from({ length: 100 + Math.floor(random() * 501) }, tool)],
    [5, () => request("approval")],
    [3, () => request("callback")],
    [3, () => request("question")],
    [14, resolve],
    [6, fail],
    [
      8,
      () => [message(now(), `assistant:${turnId}`, "assistant", turnId, "Working", random() < 0.5)],
    ],
    [4, () => [message(now(), `user-${tick}`, "user", null, "Next")]],
    [5, completeTurn],
    [1, revert],
  ];
  const totalWeight = actions.reduce((sum, [weight]) => sum + weight, 0);
  const events = [created(THREAD)];
  for (let step = 0; step < steps; step++) {
    let roll = random() * totalWeight;
    const [, act] = actions.find(([weight]) => (roll -= weight) < 0)!;
    events.push(...act());
  }
  return events;
}

it.layer(NodeServices.layer)("command model decider parity", (it) => {
  // The command projector drops non-user messages, checkpoint file lists, and
  // non-request activities (it keeps them without payload while a request is
  // open). After each stage, the decider must decide every command the same
  // way on that slim model as on the full history.
  it.effect("decides the same on the slim command model as on full history", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(BASE, { seconds: 1_000 })));
      let slim = createEmptyReadModel(at(0));
      const histories = new Map<string, FullHistory>();
      const summaries: string[] = [];
      for (const stage of stages) {
        for (const event of stage) {
          recordEvent(histories, event);
          slim = yield* projectEvent(slim, { ...event, sequence: slim.snapshotSequence + 1 });
        }
        const full = {
          ...slim,
          threads: slim.threads.map((thread) =>
            fullHistoryThread(thread, histories.get(thread.id)!),
          ),
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
          "settle: blocked, auto-settle: blocked, snooze: rejected, append user-1: rejected, append user-2: ok, turn start user-3: ok, missing diff turn-1: rejected, missing diff turn-2: ok, import: rejected",
          "settle: ok, auto-settle: blocked, snooze: rejected, append user-1: rejected, append user-2: ok, turn start user-3: ok, missing diff turn-1: rejected, missing diff turn-2: ok, import: rejected",
        ]
      `);
    }),
  );

  // Settle, auto-settle, snooze and history import read openRequests. The
  // command model keeps all the other fields they read (session, latestTurn,
  // user messages, settle and snooze state). After every event of a random
  // timeline, openRequests on the slim model must equal main's openRequests
  // on the full history, and payload-free placeholders must exist only while
  // a request is open.
  it.effect("keeps main's open requests on random timelines", () =>
    Effect.gen(function* () {
      const summaries: string[] = [];
      for (const seed of [3, 4, 5]) {
        let slim = createEmptyReadModel(at(0));
        const histories = new Map<string, FullHistory>();
        let fullOpen = new Map<string, Activity>();
        const counts = { events: 0, open: 0, placeholders: 0, capClosed: 0 };
        for (const event of randomTimeline(seed, 250)) {
          recordEvent(histories, event);
          slim = yield* projectEvent(slim, { ...event, sequence: slim.snapshotSequence + 1 });
          const lastOpen = fullOpen;
          fullOpen = mainOpenRequests(histories.get(THREAD)!.activities);
          const label = `seed ${seed}, event ${counts.events} (${event.eventId})`;
          const { activities } = slim.threads[0]!;
          expect(openRequests({ activities }), label).toEqual(fullOpen);
          const placeholders = activities.filter((entry) => entry.payload === null).length;
          if (fullOpen.size === 0) expect(placeholders, label).toBe(0);

          counts.events += 1;
          if (fullOpen.size > 0) counts.open += 1;
          if (placeholders > 0) counts.placeholders += 1;
          if (
            event.type === "thread.activity-appended" &&
            event.payload.activity.kind.startsWith("tool.") &&
            [...lastOpen.keys()].some((requestId) => !fullOpen.has(requestId))
          ) {
            counts.capClosed += 1;
          }
        }
        summaries.push(
          `seed ${seed}: ${counts.events} events, ${counts.open} with a request open, ${counts.placeholders} with placeholders, ${counts.capClosed} closed by the cap`,
        );
      }

      // Each timeline has idle stretches, open requests with placeholders, and
      // requests the activity cap closes, so the checks above are not vacuous.
      expect(summaries).toMatchInlineSnapshot(`
        [
          "seed 3: 2083 events, 1209 with a request open, 1189 with placeholders, 6 closed by the cap",
          "seed 4: 2454 events, 579 with a request open, 548 with placeholders, 3 closed by the cap",
          "seed 5: 2180 events, 930 with a request open, 913 with placeholders, 2 closed by the cap",
        ]
      `);
    }),
  );
});
