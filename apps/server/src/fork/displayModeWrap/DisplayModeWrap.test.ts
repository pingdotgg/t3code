import { assert, it } from "@effect/vitest";
import {
  ComposerContextId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  CHAT_REPLIES_DISPLAY_MODE,
  type DisplayMode,
  displayNote,
  NORMAL_DISPLAY,
  NORMAL_DISPLAY_MODE,
  recapLine,
  shortId,
  SUB_THREAD_RECORD_KIND,
  toldKey,
} from "@t3tools/shared/displayModes";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderTurnControlService from "../../orchestration-v2/ProviderTurnControlService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SubThreads from "../subThreads/SubThreads.ts";
import * as DisplayModeWrap from "./DisplayModeWrap.ts";
import { layerNoProviders } from "./DisplayModeWrap.testkit.ts";

const sourceId = ThreadId.make("thread:display-wrap:source");
const forkId = ThreadId.make("thread:display-wrap:fork");
const deletedId = ThreadId.make("thread:display-wrap:deleted");
const deletedDashboardId = ThreadId.make("thread:display-wrap:deleted-dashboard");
const dashboardId = ThreadId.make("thread:display-wrap:dashboard");
const rolledBackId = ThreadId.make("thread:display-wrap:rolled-back");
const longId = ThreadId.make("thread:display-wrap:long");
const busyId = ThreadId.make("thread:display-wrap:busy");
const doneId = ThreadId.make("thread:display-wrap:done");
const newId = ThreadId.make("thread:display-wrap:new");
const rewrittenId = ThreadId.make("thread:display-wrap:rewritten");
const latestId = ThreadId.make("thread:display-wrap:latest");
const ownCallId = ThreadId.make("thread:display-wrap:own-call");
const mainFirstId = ThreadId.make("thread:display-wrap:main-first");
const switchId = ThreadId.make("thread:display-wrap:switch");
const repliesId = ThreadId.make("thread:display-wrap:replies");
const providerThreadId = ProviderThreadId.make("provider-thread:display-wrap");
const providerTurnId = ProviderTurnId.make("provider-turn:display-wrap");
const providerSessionId = ProviderSessionId.make("session:display-wrap");
const attemptId = RunAttemptId.make("attempt:display-wrap");
const runId = RunId.make("run:display-wrap");
const forkRunId = RunId.make("run:display-wrap:fork");
const nodeId = NodeId.make("node:display-wrap");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-6" };
const steerId = MessageId.make("message:display-wrap:steer");
const forkMessageId = MessageId.make("message:display-wrap:fork");

const store = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const settings = ServerSettings.layerTest({
  threadDisplayModes: {
    [sourceId]: "chat-replies",
    [forkId]: "chat-replies",
    [deletedId]: "chat-replies",
    [rolledBackId]: "chat-replies",
    [longId]: "chat-replies",
    [busyId]: "chat-replies",
    [doneId]: "chat-replies",
    [newId]: "chat-replies",
    [rewrittenId]: "chat-replies",
    [repliesId]: "chat-replies",
  },
  threadDashboards: { [deletedDashboardId]: true, [dashboardId]: true },
});
const providers = Layer.mock(ProviderRegistry.ProviderRegistry)({
  getProviders: Effect.succeed([
    {
      instanceId: providerInstanceId,
      driver,
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [{ name: "compact" }, { name: "review" }],
      skills: [],
    },
  ]),
});
const wrapper = DisplayModeWrap.layer.pipe(
  Layer.provide(Layer.mergeAll(store, settings, providers)),
);
const wrapperWithoutCommands = DisplayModeWrap.layer.pipe(
  Layer.provide(Layer.mergeAll(store, settings, layerNoProviders)),
);

const threadCreated = (
  now: DateTime.Utc,
  id: ThreadId,
  forkedFrom: { readonly type: "run"; readonly threadId: ThreadId; readonly runId: RunId } | null,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`display-wrap:thread:${id}`),
  type: "thread.created",
  threadId: id,
  occurredAt: now,
  payload: {
    id,
    projectId: ProjectId.make("project:display-wrap"),
    title: "Display wrap",
    providerInstanceId,
    modelSelection,
    createdBy: "user",
    creationSource: "web",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/workspace",
    activeProviderThreadId: id === sourceId ? providerThreadId : null,
    lineage:
      forkedFrom === null
        ? { parentThreadId: null, relationshipToParent: null, rootThreadId: id }
        : { parentThreadId: sourceId, relationshipToParent: "fork", rootThreadId: sourceId },
    forkedFrom,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
});

const runCreated = (
  now: DateTime.Utc,
  threadId: ThreadId,
  id: RunId,
  status: "running" | "completed" | "rolled_back" | "cancelled",
  ordinal = 1,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`display-wrap:run:${id}`),
  type: "run.created",
  threadId,
  occurredAt: now,
  payload: {
    id,
    threadId,
    ordinal,
    providerInstanceId,
    modelSelection,
    providerThreadId: threadId === sourceId ? providerThreadId : null,
    userMessageId: MessageId.make(`message:${id}`),
    rootNodeId: nodeId,
    activeAttemptId: threadId === sourceId ? attemptId : null,
    status,
    requestedAt: now,
    startedAt: now,
    completedAt: status === "completed" ? now : null,
    checkpointId: null,
    contextHandoffId: null,
  },
});

type ItemFields =
  | {
      readonly type: "user_message";
      readonly messageId: MessageId;
      readonly text: string;
      readonly inputIntent: "turn_start" | "steer" | "queued_turn";
      readonly status?: "pending";
      readonly creationSource?: "web" | "server";
      /** The first message that this message replies under. */
      readonly under?: string;
    }
  | { readonly type: "assistant_message"; readonly messageId: MessageId; readonly text: string }
  | {
      readonly type: "send_to_user" | "replace_send_to_user";
      readonly text: string;
      readonly status?: "failed" | "running";
      /** The short id of the user message that a send answers. */
      readonly replyTo?: string;
    }
  | { readonly type: "command_execution" };

const replyContext = (first: string) => ({
  version: 1 as const,
  records: [
    {
      version: 1 as const,
      contextId: ComposerContextId.make("fork-reply"),
      kind: SUB_THREAD_RECORD_KIND,
      label: "Reply",
      payload: { first },
    },
  ],
});

const itemUpdated = (
  now: DateTime.Utc,
  threadId: ThreadId,
  run: RunId,
  ordinal: number,
  fields: ItemFields,
): OrchestrationV2DomainEvent => {
  const base = {
    id: TurnItemId.make(`item:${threadId}:${ordinal}`),
    threadId,
    runId: run,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
  const payload: OrchestrationV2TurnItem =
    fields.type === "user_message"
      ? {
          ...base,
          creationSource: "web",
          ...fields,
          attachments: [],
          createdBy: "user",
          ...(fields.under === undefined ? {} : { context: replyContext(fields.under) }),
        }
      : fields.type === "assistant_message"
        ? { ...base, ...fields, streaming: false }
        : fields.type === "send_to_user" || fields.type === "replace_send_to_user"
          ? {
              ...base,
              status: fields.status ?? base.status,
              type: "dynamic_tool",
              toolName: `mcp__t3-code__${fields.type}`,
              input:
                fields.type === "send_to_user"
                  ? {
                      text: fields.text,
                      ...(fields.replyTo === undefined ? {} : { reply_to: fields.replyTo }),
                    }
                  : { user_message: "", old_text: "", new_text: fields.text },
            }
          : { ...base, type: "command_execution", input: "make test" };
  return {
    id: EventId.make(`display-wrap:item:${threadId}:${ordinal}`),
    type: "turn-item.updated",
    threadId,
    runId: run,
    nodeId,
    driver,
    occurredAt: now,
    payload,
  };
};

/** The source thread has a message, a sent reply, and then tool work that the user never saw. */
const seedSource = Effect.fn("seedSource")(function* (now: DateTime.Utc) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
    threadCreated(now, sourceId, null),
    runCreated(now, sourceId, runId, "running"),
    itemUpdated(now, sourceId, runId, 100, {
      type: "user_message",
      messageId: MessageId.make("message:display-wrap:first"),
      text: "Fix the build.",
      inputIntent: "turn_start",
    }),
    itemUpdated(now, sourceId, runId, 101, { type: "send_to_user", text: "On it." }),
    itemUpdated(now, sourceId, runId, 102, { type: "command_execution" }),
  ];
  yield* Effect.forEach(events, (event) => projections.apply(event), { discard: true });
});

const steered: string[] = [];
let refuseSteer = false;
// Steering never reads the event stream.
const eventSink = Layer.mock(EventSink.EventSinkV2)({});
const sessions = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
  get: () =>
    Effect.succeedSome({
      steerTurn: (input: { readonly message: { readonly text: string } }) =>
        Effect.suspend(() => {
          steered.push(input.message.text);
          return refuseSteer ? Effect.fail("refused") : Effect.void;
        }),
    } as never),
});

/** A message that the user typed in the main list of a Chat mode thread, as the agent gets it. */
const inMainList = (id: string, text: string) =>
  [
    "<t3-replies-mode>",
    `Message "${shortId(id)}" from the user in the main list.`,
    `To answer, call send_to_user with reply_to "${shortId(id)}" and the user's words below as user_message. Your answer shows in the main list.`,
    "</t3-replies-mode>",
    text,
  ].join("\n");

/** A message typed with the id `message:<its text>` in the main list of a Chat mode thread. */
const typedInChat = (text: string) => inMainList(`message:${text}`, text);

/** The first message that the user types after the thread switched to Chat mode. */
const told = (text: string) => `${CHAT_REPLIES_DISPLAY_MODE.notice}\n${text}`;

/** The first message that the user types after the agent may have lost its note, with no Dashboard. */
const stated = (mode: DisplayMode, text: string) =>
  `${displayNote("unknown", { mode, dashboard: false })}\n${text}`;

/** Returns the text that a provider gets for a message, and accepts the turn. */
const deliver = Effect.fn("deliver")(function* (input: {
  readonly threadId: ThreadId;
  readonly id: MessageId;
  readonly text: string;
  readonly creationSource?: "web" | "mobile" | "server";
  readonly context?: DisplayModeWrap.NoteContext;
  readonly under?: string;
}) {
  const wrap = yield* DisplayModeWrap.DisplayModeWrap;
  const wrapped = yield* wrap.wrapUserText({
    threadId: input.threadId,
    message: {
      id: input.id,
      createdBy: "user",
      creationSource: input.creationSource ?? "web",
      text: input.text,
      ...(input.under === undefined ? {} : { context: replyContext(input.under) }),
    },
    text: input.text,
    ...(input.context === undefined ? {} : { context: input.context }),
  });
  yield* wrapped.accepted;
  return wrapped.text;
});

/** The source thread's running turn, and `text` as a steering message to it. */
const seedSteer = Effect.fn("seedSteer")(function* (now: DateTime.Utc, text: string) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const extra: ReadonlyArray<OrchestrationV2DomainEvent> = [
    {
      id: EventId.make("display-wrap:provider-thread"),
      type: "provider-thread.updated",
      threadId: sourceId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId,
        appThreadId: sourceId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native-display-wrap", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      id: EventId.make("display-wrap:attempt"),
      type: "run-attempt.created",
      threadId: sourceId,
      occurredAt: now,
      payload: {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId,
        providerTurnId,
        reason: "initial",
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    },
    {
      id: EventId.make("display-wrap:turn"),
      type: "provider-turn.updated",
      threadId: sourceId,
      occurredAt: now,
      payload: {
        id: providerTurnId,
        providerThreadId,
        nodeId,
        runAttemptId: attemptId,
        nativeTurnRef: { driver, nativeId: "native-display-wrap-turn", strength: "strong" },
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    },
    {
      id: EventId.make("display-wrap:steer-message"),
      type: "message.updated",
      threadId: sourceId,
      occurredAt: now,
      payload: {
        id: steerId,
        threadId: sourceId,
        runId,
        nodeId,
        role: "user",
        text,
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
      },
    },
    itemUpdated(now, sourceId, runId, 103, {
      type: "user_message",
      messageId: steerId,
      text,
      inputIntent: "steer",
    }),
  ];
  yield* Effect.forEach(extra, (event) => projections.apply(event), { discard: true });
});

it.effect("wraps a steering message sent after the agent's hidden tool work", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    yield* seedSource(now);
    yield* seedSteer(now, "Use the smaller fix.");

    const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
    const steer = control.steer({
      threadId: sourceId,
      providerSessionId,
      providerThreadId,
      providerTurnId,
      messageId: steerId,
    });
    refuseSteer = true;
    yield* Effect.exit(steer);
    refuseSteer = false;
    yield* steer;
    yield* steer;
    const block = inMainList(steerId, "Use the smaller fix.");
    assert.deepEqual(steered, [told(block), told(block), block]);
  }).pipe(
    Effect.provide(
      Layer.merge(
        store,
        ProviderTurnControlService.layer.pipe(
          Layer.provide(Layer.mergeAll(store, sessions, wrapper, eventSink)),
        ),
      ),
    ),
  ),
);

it.effect("leaves the note owed after a slash command sent as a steer", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    yield* seedSource(now);
    yield* seedSteer(now, "/review");
    const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
    const wrap = yield* DisplayModeWrap.DisplayModeWrap;
    const earlier = steered.length;
    yield* control.steer({
      threadId: sourceId,
      providerSessionId,
      providerThreadId,
      providerTurnId,
      messageId: steerId,
    });
    assert.deepEqual(steered.slice(earlier), ["/review"]);
    const next = yield* wrap.wrapUserText({
      threadId: sourceId,
      message: { id: steerId, createdBy: "user", creationSource: "web", text: "/review" },
      text: "/review",
    });
    assert.strictEqual(next.commandNote?.text, CHAT_REPLIES_DISPLAY_MODE.notice);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        store,
        wrapper,
        ProviderTurnControlService.layer.pipe(
          Layer.provide(Layer.mergeAll(store, sessions, wrapper, eventSink)),
        ),
      ),
    ),
  ),
);

it.effect("counts the history a fork inherits from its source", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* seedSource(now);
    const forkEvents: ReadonlyArray<OrchestrationV2DomainEvent> = [
      threadCreated(now, forkId, { type: "run", threadId: sourceId, runId }),
      runCreated(now, forkId, forkRunId, "running"),
      itemUpdated(now, forkId, forkRunId, 1_000_100, {
        type: "user_message",
        messageId: forkMessageId,
        text: "Try another way.",
        inputIntent: "turn_start",
      }),
    ];
    yield* Effect.forEach(forkEvents, (event) => projections.apply(event), { discard: true });
    const wrap = yield* DisplayModeWrap.DisplayModeWrap;
    assert.deepEqual(
      (yield* wrap.latestShownItems(forkId, undefined, 3, false)).map((item) => item.ordinal),
      [100, 101, 1_000_100],
    );
  }).pipe(Effect.provide(Layer.merge(store, wrapper))),
);

it.effect("does not count rewrites as messages when it reads back", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const message = (ordinal: number, text: string) =>
      itemUpdated(now, rewrittenId, runId, ordinal, {
        type: "user_message",
        messageId: MessageId.make(`message:display-wrap:rewritten:${ordinal}`),
        text,
        inputIntent: ordinal === 1 ? "turn_start" : "steer",
      });
    const rewrites = Array.from({ length: 10 }, (_, index) =>
      itemUpdated(now, rewrittenId, runId, 5 + index, {
        type: "replace_send_to_user",
        text: `On it, take ${index + 1}.`,
      }),
    );
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      threadCreated(now, rewrittenId, null),
      runCreated(now, rewrittenId, runId, "running"),
      message(1, "First."),
      itemUpdated(now, rewrittenId, runId, 2, { type: "send_to_user", text: "Hello." }),
      message(3, "Fix the build."),
      itemUpdated(now, rewrittenId, runId, 4, { type: "send_to_user", text: "On it." }),
      ...rewrites,
      message(15, "Any news?"),
    ];
    yield* Effect.forEach(events, (event) => projections.apply(event), { discard: true });
    const wrap = yield* DisplayModeWrap.DisplayModeWrap;
    const ordinals = (yield* wrap.latestShownItems(rewrittenId, undefined, 3, false)).map(
      (item) => item.ordinal,
    );
    // Three messages back: "Any news?", "On it." and "Fix the build.", with the rewrites between.
    assert.deepEqual(ordinals, [3, 4, ...rewrites.map((_, index) => 5 + index), 15]);
  }).pipe(Effect.provide(Layer.merge(store, wrapper))),
);

it.effect("reads the latest shown items back past the user's last typed message", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const wrap = yield* DisplayModeWrap.DisplayModeWrap;
    const message = (ordinal: number, text: string, creationSource: "web" | "server" = "web") =>
      itemUpdated(now, latestId, runId, ordinal, {
        type: "user_message",
        messageId: MessageId.make(`message:display-wrap:latest:${ordinal}`),
        text,
        inputIntent: "steer",
        creationSource,
      });
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      threadCreated(now, latestId, null),
      runCreated(now, latestId, runId, "running"),
      itemUpdated(now, latestId, runId, 1, { type: "send_to_user", text: "Earlier." }),
      message(2, "Fix the build."),
      itemUpdated(now, latestId, runId, 3, { type: "send_to_user", text: "On it." }),
      message(4, "Continue where you left off.", "server"),
      itemUpdated(now, latestId, runId, 5, { type: "replace_send_to_user", text: "On it, 1." }),
      itemUpdated(now, latestId, runId, 6, { type: "command_execution" }),
      itemUpdated(now, latestId, runId, 7, { type: "send_to_user", text: "Done." }),
      itemUpdated(now, latestId, runId, 8, {
        type: "send_to_user",
        text: "Also.",
        status: "running",
      }),
    ];
    yield* Effect.forEach(events, (event) => projections.apply(event), { discard: true });
    const ordinals = (yield* wrap.latestShownItems(latestId, undefined, 3, false)).map(
      (item) => item.ordinal,
    );
    // Back to the typed message at 2, which with the sends after it makes 3 messages.
    assert.deepEqual(ordinals, [2, 3, 4, 5, 7, 8]);
  }).pipe(Effect.provide(Layer.merge(store, wrapper))),
);

it.effect("counts back from the caller's own item when it names one", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const wrap = yield* DisplayModeWrap.DisplayModeWrap;
    const message = (ordinal: number, text: string) =>
      itemUpdated(now, ownCallId, runId, ordinal, {
        type: "user_message",
        messageId: MessageId.make(`message:display-wrap:own-call:${ordinal}`),
        text,
        inputIntent: "steer",
      });
    const ownCall = itemUpdated(now, ownCallId, runId, 2, {
      type: "send_to_user",
      text: "On it.",
      status: "running",
    });
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      threadCreated(now, ownCallId, null),
      runCreated(now, ownCallId, runId, "running"),
      message(1, "Fix the build."),
      ownCall.type === "turn-item.updated"
        ? {
            ...ownCall,
            payload: {
              ...ownCall.payload,
              nativeItemRef: { driver, nativeId: "toolu_own", strength: "strong" },
            },
          }
        : ownCall,
      message(3, "Also run the tests."),
      message(4, "And the linter."),
      itemUpdated(now, ownCallId, runId, 5, { type: "send_to_user", text: "Tests pass." }),
    ];
    yield* Effect.forEach(events, (event) => projections.apply(event), { discard: true });
    const ordinals = (yield* wrap.latestShownItems(ownCallId, "toolu_own", 3, false)).map(
      (item) => item.ordinal,
    );
    // The typed message before the call's own item is read, though two came after it.
    assert.deepEqual(ordinals, [1, 2, 3, 4, 5]);
  }).pipe(Effect.provide(Layer.merge(store, wrapper))),
);

it.effect("reads back to the latest message of the main list when asked, past many replies", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const wrap = yield* DisplayModeWrap.DisplayModeWrap;
    const news = itemUpdated(now, mainFirstId, runId, 2, { type: "send_to_user", text: "News." });
    const replies = Array.from({ length: 125 }, (_, index) =>
      itemUpdated(now, mainFirstId, runId, index + 3, {
        type: "user_message",
        messageId: MessageId.make(`message:display-wrap:main-first:${index + 3}`),
        text: `Reply ${index + 3}`,
        inputIntent: "steer",
        under: `item:${mainFirstId}:2`,
      }),
    );
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      threadCreated(now, mainFirstId, null),
      runCreated(now, mainFirstId, runId, "running"),
      itemUpdated(now, mainFirstId, runId, 1, {
        type: "user_message",
        messageId: MessageId.make("message:display-wrap:main-first:1"),
        text: "Ship it.",
        inputIntent: "turn_start",
      }),
      news,
      ...replies,
    ];
    yield* Effect.forEach(events, (event) => projections.apply(event), { discard: true });
    const first = (items: ReadonlyArray<OrchestrationV2TurnItem>) => items[0]?.ordinal;
    assert.strictEqual(first(yield* wrap.latestShownItems(mainFirstId, undefined, 120, false)), 8);
    // The agent's news at 2 is the main list's latest message; the user's first message is not needed.
    assert.strictEqual(first(yield* wrap.latestShownItems(mainFirstId, undefined, 120, true)), 2);
  }).pipe(Effect.provide(Layer.merge(store, wrapper))),
);

it.effect("reads back no further than it needs past many runs of the user's messages", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const firstRunId = RunId.make("run:display-wrap:long:0");
    // The thread has tool work and then many user turns. No turn in the thread has a sent message.
    const turns = Array.from({ length: 12 }, (_, index) => {
      const turnRunId = RunId.make(`run:display-wrap:long:${index + 1}`);
      return [
        runCreated(now, longId, turnRunId, "completed", index + 2),
        itemUpdated(now, longId, turnRunId, 10 * (index + 1), {
          type: "user_message",
          messageId: MessageId.make(`message:display-wrap:long:${index + 1}`),
          text: `Note ${index + 1}`,
          inputIntent: "turn_start",
        }),
      ];
    }).flat();
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      threadCreated(now, longId, null),
      runCreated(now, longId, firstRunId, "completed"),
      itemUpdated(now, longId, firstRunId, 1, {
        type: "user_message",
        messageId: MessageId.make("message:display-wrap:long:0"),
        text: "Fix the build.",
        inputIntent: "turn_start",
      }),
      itemUpdated(now, longId, firstRunId, 2, { type: "command_execution" }),
      ...turns,
    ];
    yield* Effect.forEach(events, (event) => projections.apply(event), { discard: true });
    const wrap = yield* DisplayModeWrap.DisplayModeWrap;
    const ordinals = (yield* wrap.latestShownItems(longId, undefined, 3, false)).map(
      (item) => item.ordinal,
    );
    assert.deepEqual(ordinals, [100, 110, 120]);
  }).pipe(Effect.provide(Layer.merge(store, wrapper))),
);

it.effect("reads past thousands of tool calls for the decision and the listed messages", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const commandCount = 3_000;
    const thread = (threadId: ThreadId) => {
      const run = RunId.make(`run:${threadId}`);
      const messageId = (ordinal: number) => MessageId.make(`message:${threadId}:${ordinal}`);
      return {
        start: [threadCreated(now, threadId, null), runCreated(now, threadId, run, "running")],
        message: (ordinal: number, text: string) =>
          itemUpdated(now, threadId, run, ordinal, {
            type: "user_message",
            messageId: messageId(ordinal),
            text,
            inputIntent: ordinal === 1 ? "turn_start" : "steer",
          }),
        send: (ordinal: number, text: string) =>
          itemUpdated(now, threadId, run, ordinal, { type: "send_to_user", text }),
        commands: (from: number) =>
          Array.from({ length: commandCount }, (_, index) =>
            itemUpdated(now, threadId, run, from + index, { type: "command_execution" }),
          ),
      };
    };
    const busy = thread(busyId);
    const done = thread(doneId);
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      ...busy.start,
      busy.message(1, "Fix the build."),
      busy.send(2, "On it."),
      busy.message(3, "Keep going."),
      busy.send(4, "Halfway there."),
      ...busy.commands(5),
      busy.message(commandCount + 5, "Any news?"),
      ...done.start,
      done.message(1, "Fix the build."),
      ...done.commands(2),
      done.send(commandCount + 2, "All done."),
      done.message(commandCount + 3, "Thanks"),
    ];
    yield* Effect.forEach(events, (event) => projections.apply(event), { discard: true });
    const wrap = yield* DisplayModeWrap.DisplayModeWrap;
    const ordinals = (threadId: ThreadId) =>
      wrap
        .latestShownItems(threadId, undefined, 3, false)
        .pipe(Effect.map((items) => items.map((item) => item.ordinal)));
    assert.deepEqual(yield* ordinals(busyId), [3, 4, commandCount + 5]);
    assert.deepEqual(yield* ordinals(doneId), [1, commandCount + 2, commandCount + 3]);
  }).pipe(Effect.provide(Layer.merge(store, wrapper))),
);

it.effect("leaves out the messages of a rolled-back run and a cancelled queued turn", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const undoneRunId = RunId.make("run:display-wrap:rolled-back:undone");
    const nextRunId = RunId.make("run:display-wrap:rolled-back:next");
    const nextMessageId = MessageId.make("message:display-wrap:rolled-back:next");
    const cancelledRunId = RunId.make("run:display-wrap:rolled-back:cancelled");
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      threadCreated(now, rolledBackId, null),
      runCreated(now, rolledBackId, runId, "completed"),
      itemUpdated(now, rolledBackId, runId, 1, {
        type: "user_message",
        messageId: MessageId.make("message:display-wrap:rolled-back:first"),
        text: "Fix the build.",
        inputIntent: "turn_start",
      }),
      itemUpdated(now, rolledBackId, runId, 2, { type: "send_to_user", text: "On it." }),
      itemUpdated(now, rolledBackId, runId, 3, { type: "command_execution" }),
      runCreated(now, rolledBackId, undoneRunId, "rolled_back", 2),
      itemUpdated(now, rolledBackId, undoneRunId, 4, {
        type: "user_message",
        messageId: MessageId.make("message:display-wrap:rolled-back:undone"),
        text: "Try the other fix.",
        inputIntent: "turn_start",
      }),
      itemUpdated(now, rolledBackId, undoneRunId, 5, { type: "send_to_user", text: "Tried it." }),
      runCreated(now, rolledBackId, cancelledRunId, "cancelled", 3),
      itemUpdated(now, rolledBackId, cancelledRunId, 6, {
        type: "user_message",
        messageId: MessageId.make("message:display-wrap:rolled-back:cancelled"),
        text: "Never mind this.",
        inputIntent: "queued_turn",
      }),
      runCreated(now, rolledBackId, nextRunId, "running", 4),
      itemUpdated(now, rolledBackId, nextRunId, 7, {
        type: "user_message",
        messageId: nextMessageId,
        text: "Any news?",
        inputIntent: "turn_start",
      }),
    ];
    yield* Effect.forEach(events, (event) => projections.apply(event), { discard: true });
    const wrap = yield* DisplayModeWrap.DisplayModeWrap;
    const ordinals = (yield* wrap.latestShownItems(rolledBackId, undefined, 3, false)).map(
      (item) => item.ordinal,
    );
    assert.deepEqual(ordinals, [1, 2, 7]);
  }).pipe(Effect.provide(Layer.merge(store, wrapper))),
);

it.effect(
  "sends the provider's slash commands unchanged and wraps other text that starts with /",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* seedSource(now);
      const sendAt = Effect.fn("sendAt")(function* (ordinal: number, text: string) {
        const id = MessageId.make(`message:display-wrap:${ordinal}`);
        yield* projections.apply(
          itemUpdated(now, sourceId, runId, ordinal, {
            type: "user_message",
            messageId: id,
            text,
            inputIntent: "steer",
          }),
        );
        return yield* deliver({ threadId: sourceId, id, text });
      });
      assert.strictEqual(yield* sendAt(103, "/compact"), "/compact");
      assert.strictEqual(yield* sendAt(104, "/REVIEW"), "/REVIEW");
      assert.strictEqual(
        yield* sendAt(105, "/tmp is full"),
        told(inMainList("message:display-wrap:105", "/tmp is full")),
      );
    }).pipe(Effect.provide(Layer.merge(store, wrapper))),
);

it.effect(
  "sends T3 Code's own /compact and /goal unchanged when the provider's list omits them",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* seedSource(now);
      const sendAt = Effect.fn("sendAt")(function* (ordinal: number, text: string) {
        const id = MessageId.make(`message:display-wrap:${ordinal}`);
        yield* projections.apply(
          itemUpdated(now, sourceId, runId, ordinal, {
            type: "user_message",
            messageId: id,
            text,
            inputIntent: "steer",
          }),
        );
        return yield* deliver({ threadId: sourceId, id, text });
      });
      assert.strictEqual(yield* sendAt(103, "/compact"), "/compact");
      assert.strictEqual(yield* sendAt(104, " /COMPACT "), " /COMPACT ");
      assert.strictEqual(yield* sendAt(105, "/goal ship it"), "/goal ship it");
      assert.strictEqual(
        yield* sendAt(106, "Any news?"),
        told(inMainList("message:display-wrap:106", "Any news?")),
      );
    }).pipe(Effect.provide(Layer.merge(store, wrapperWithoutCommands))),
);

it.effect("gives an owed note to a slash command as its context, told once delivered", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const wrap = yield* DisplayModeWrap.DisplayModeWrap;
    yield* seedSource(now);
    const command = (text: string) =>
      wrap.wrapUserText({
        threadId: sourceId,
        message: {
          id: MessageId.make(`message:${text}`),
          createdBy: "user",
          creationSource: "web",
          text,
        },
        text,
      });
    const compact = yield* command("/compact");
    assert.deepEqual([compact.text, compact.commandNote], ["/compact", undefined]);
    const review = yield* command("/review");
    assert.deepEqual(
      [review.text, review.commandNote?.text],
      ["/review", CHAT_REPLIES_DISPLAY_MODE.notice],
    );
    yield* review.accepted;
    const again = yield* command("/review");
    assert.strictEqual(again.commandNote?.text, CHAT_REPLIES_DISPLAY_MODE.notice);
    yield* again.commandNote?.delivered ?? Effect.void;
    assert.isUndefined((yield* command("/review")).commandNote);
  }).pipe(Effect.provide(Layer.merge(store, wrapper))),
);

it.effect(
  "wraps /compact and /goal sent with an attachment, because they then run as prompts",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const wrap = yield* DisplayModeWrap.DisplayModeWrap;
      yield* seedSource(now);
      for (const [ordinal, text] of [
        [103, "/compact"],
        [104, "/goal ship it"],
      ] as const) {
        const id = MessageId.make(`message:display-wrap:${ordinal}`);
        yield* projections.apply(
          itemUpdated(now, sourceId, runId, ordinal, {
            type: "user_message",
            messageId: id,
            text,
            inputIntent: "steer",
          }),
        );
        const wrapped = yield* wrap.wrapUserText({
          threadId: sourceId,
          message: {
            id,
            createdBy: "user",
            creationSource: "web",
            text,
            attachments: [{ type: "image" }],
          },
          text,
        });
        assert.isTrue(wrapped.text.startsWith(CHAT_REPLIES_DISPLAY_MODE.notice));
      }
    }).pipe(Effect.provide(Layer.merge(store, wrapperWithoutCommands))),
);

it.effect("tells the agent about the mode on the first typed message after each switch", () =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const send = (
      threadId: ThreadId,
      text: string,
      creationSource: "web" | "mobile" | "server" = "web",
    ) => deliver({ threadId, id: MessageId.make(`message:${text}`), text, creationSource });
    const switchTo = (mode: string | null) =>
      serverSettings.updateSettings({ threadDisplayModes: { [switchId]: mode } });

    assert.strictEqual(yield* send(newId, "First"), told(typedInChat("First")));
    assert.strictEqual(yield* send(newId, "Second"), typedInChat("Second"));

    assert.strictEqual(yield* send(switchId, "Hello"), "Hello");
    yield* switchTo("chat-replies");
    assert.strictEqual(
      yield* send(switchId, "Continue where you left off.", "server"),
      "Continue where you left off.",
    );
    assert.strictEqual(yield* send(switchId, "From the phone", "mobile"), "From the phone");
    assert.strictEqual(yield* send(switchId, "Status?"), told(typedInChat("Status?")));
    assert.strictEqual(yield* send(switchId, "Thanks"), typedInChat("Thanks"));
    yield* switchTo(null);
    assert.strictEqual(
      yield* send(switchId, "Show me everything"),
      `${NORMAL_DISPLAY_MODE.notice}\nShow me everything`,
    );
    assert.strictEqual(yield* send(switchId, "Next"), "Next");

    const dashboardOn = { mode: NORMAL_DISPLAY_MODE, dashboard: true };
    const dashboard = (on: true | null) =>
      serverSettings.updateSettings({ threadDashboards: { [switchId]: on } });
    yield* dashboard(true);
    assert.strictEqual(
      yield* send(switchId, "Show the Dashboard"),
      `${displayNote(toldKey(NORMAL_DISPLAY), dashboardOn)}\nShow the Dashboard`,
    );
    assert.strictEqual(yield* send(switchId, "Anything new?"), "Anything new?");
    yield* dashboard(null);
    assert.strictEqual(
      yield* send(switchId, "Hide it"),
      `${displayNote(toldKey(dashboardOn), NORMAL_DISPLAY)}\nHide it`,
    );
  }).pipe(Effect.provide(Layer.mergeAll(store, settings, wrapper))),
);

it.effect("adds nothing to a message typed in the mobile app", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* seedSource(now);
    const id = MessageId.make("message:display-wrap:mobile");
    yield* projections.apply(
      itemUpdated(now, sourceId, runId, 103, {
        type: "user_message",
        messageId: id,
        text: "Status?",
        inputIntent: "steer",
      }),
    );
    const typed = (creationSource: "web" | "mobile") =>
      deliver({ threadId: sourceId, id, text: "Status?", creationSource });
    assert.strictEqual(yield* typed("mobile"), "Status?");
    assert.strictEqual(yield* typed("web"), told(inMainList(id, "Status?")));
  }).pipe(Effect.provide(Layer.merge(store, wrapper))),
);

it.effect("sends the note again until the provider accepts the turn", () =>
  Effect.gen(function* () {
    const wrap = yield* DisplayModeWrap.DisplayModeWrap;
    const input = {
      threadId: newId,
      message: {
        id: MessageId.make("message:display-wrap:retried"),
        createdBy: "user" as const,
        creationSource: "web" as const,
        text: "First",
      },
      text: "First",
    };
    const typed = inMainList(input.message.id, "First");
    assert.strictEqual((yield* wrap.wrapUserText(input)).text, told(typed));
    const retried = yield* wrap.wrapUserText(input);
    assert.strictEqual(retried.text, told(typed));
    yield* retried.accepted;
    assert.strictEqual((yield* wrap.wrapUserText(input)).text, typed);
  }).pipe(Effect.provide(Layer.mergeAll(store, settings, wrapper))),
);

it.effect("tells a new provider context again, whichever message starts it", () =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const send = (text: string, options: { server?: boolean; fresh?: boolean } = {}) =>
      deliver({
        threadId: switchId,
        id: MessageId.make(`message:${text}`),
        text,
        ...(options.server ? { creationSource: "server" as const } : {}),
        ...(options.fresh ? { context: "fresh" as const } : {}),
      });
    yield* serverSettings.updateSettings({ threadDisplayModes: { [switchId]: "chat-replies" } });
    assert.strictEqual(yield* send("First"), told(typedInChat("First")));
    assert.strictEqual(yield* send("Second"), typedInChat("Second"));
    assert.strictEqual(
      yield* send("After a handoff", { fresh: true }),
      told(typedInChat("After a handoff")),
    );
    assert.strictEqual(yield* send("Next"), typedInChat("Next"));
    assert.strictEqual(
      yield* send("Continue where you left off.", { server: true, fresh: true }),
      "Continue where you left off.",
    );
    assert.strictEqual(yield* send("Status?"), told(typedInChat("Status?")));
    // A new agent starts in the full view, so a Normal thread has nothing to tell it.
    yield* serverSettings.updateSettings({ threadDisplayModes: { [switchId]: null } });
    assert.strictEqual(yield* send("In Normal", { fresh: true }), "In Normal");
  }).pipe(Effect.provide(Layer.mergeAll(store, settings, wrapper))),
);

it.effect("tells the agent its mode again after a rollback, if it was told one", () =>
  Effect.gen(function* () {
    const wrap = yield* DisplayModeWrap.DisplayModeWrap;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const threadId = ThreadId.make("thread:display-wrap:forget");
    const send = (text: string) =>
      deliver({ threadId, id: MessageId.make(`message:${text}`), text });
    const switchTo = (mode: string | null) =>
      serverSettings.updateSettings({ threadDisplayModes: { [threadId]: mode } });
    const normalNote = (text: string) => `${NORMAL_DISPLAY_MODE.notice}\n${text}`;

    yield* wrap.forgetNotes(threadId);
    assert.strictEqual(yield* send("Never told"), "Never told");
    yield* switchTo("chat-replies");
    assert.strictEqual(yield* send("Switched"), told(typedInChat("Switched")));
    yield* wrap.forgetNotes(threadId);
    assert.strictEqual(
      yield* send("Rolled back"),
      stated(CHAT_REPLIES_DISPLAY_MODE, typedInChat("Rolled back")),
    );
    yield* switchTo(null);
    assert.strictEqual(yield* send("Back to Normal"), normalNote("Back to Normal"));
    // The rolled-back turn can be the one that carried the Normal note.
    yield* wrap.forgetNotes(threadId);
    assert.strictEqual(
      yield* send("Rolled back again"),
      stated(NORMAL_DISPLAY_MODE, "Rolled back again"),
    );
    assert.strictEqual(yield* send("Next"), "Next");
  }).pipe(Effect.provide(Layer.mergeAll(store, settings, wrapper))),
);

it.effect("tells a copied conversation its mode only when the source got a note", () =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const sourceThreadId = ThreadId.make("thread:display-wrap:copy-source");
    const send = (threadId: ThreadId, text: string, copiedFrom?: ThreadId) =>
      deliver({
        threadId,
        id: MessageId.make(`message:${text}`),
        text,
        ...(copiedFrom === undefined ? {} : { context: { copiedFrom } }),
      });
    const firstCopy = ThreadId.make("thread:display-wrap:copy-1");
    const secondCopy = ThreadId.make("thread:display-wrap:copy-2");

    assert.strictEqual(
      yield* send(firstCopy, "Copy of an untold thread", sourceThreadId),
      "Copy of an untold thread",
    );
    yield* serverSettings.updateSettings({
      threadDisplayModes: { [sourceThreadId]: "chat-replies" },
    });
    assert.strictEqual(yield* send(sourceThreadId, "Source"), told(typedInChat("Source")));
    assert.strictEqual(
      yield* send(secondCopy, "Copy of a told thread", sourceThreadId),
      stated(NORMAL_DISPLAY_MODE, "Copy of a told thread"),
    );
    assert.strictEqual(yield* send(secondCopy, "Next in the copy"), "Next in the copy");
  }).pipe(Effect.provide(Layer.mergeAll(store, settings, wrapper))),
);

it.effect("tells the agent its mode again when history joins its conversation", () =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const threadId = ThreadId.make("thread:display-wrap:uncertain");
    const send = (text: string, context?: "uncertain") =>
      deliver({
        threadId,
        id: MessageId.make(`message:${text}`),
        text,
        ...(context === undefined ? {} : { context }),
      });

    assert.strictEqual(yield* send("Never told", "uncertain"), "Never told");
    yield* serverSettings.updateSettings({ threadDisplayModes: { [threadId]: "chat-replies" } });
    assert.strictEqual(yield* send("Switched"), told(typedInChat("Switched")));
    yield* serverSettings.updateSettings({ threadDisplayModes: { [threadId]: null } });
    // The handoff's turn is the first one in Normal, so the agent can still hold only the older note.
    assert.strictEqual(
      yield* send("After a merge", "uncertain"),
      stated(NORMAL_DISPLAY_MODE, "After a merge"),
    );
    assert.strictEqual(yield* send("Next"), "Next");
  }).pipe(Effect.provide(Layer.mergeAll(store, settings, wrapper))),
);

it.effect("recaps a reply's own sub-thread in Chat mode, and reports the change", () => {
  const changes: Array<{ readonly firstId: string; readonly lines: ReadonlyArray<string> }> = [];
  const subThreads = Layer.mock(SubThreads.SubThreads)({
    changed: ({ firstId, thread }) =>
      Effect.sync(() => void changes.push({ firstId, lines: thread.map(recapLine) })),
  });
  return Effect.gen(function* () {
    const now = yield* DateTime.now;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const id = (name: string) => MessageId.make(`message:display-wrap:replies:${name}`);
    const answerId = `item:${repliesId}:2`;
    const typed = (ordinal: number, name: string, text: string, under?: string) =>
      itemUpdated(now, repliesId, runId, ordinal, {
        type: "user_message",
        messageId: id(name),
        text,
        inputIntent: ordinal === 1 ? "turn_start" : "steer",
        ...(under === undefined ? {} : { under }),
      });
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      threadCreated(now, repliesId, null),
      runCreated(now, repliesId, runId, "running"),
      typed(1, "q1", "Is the build green?"),
      itemUpdated(now, repliesId, runId, 2, {
        type: "send_to_user",
        text: "Yes, all checks pass.",
        replyTo: shortId(id("q1")),
      }),
      typed(3, "other", "Unrelated question."),
      itemUpdated(now, repliesId, runId, 4, { type: "command_execution" }),
      typed(5, "q2", "And the lint job?", answerId),
    ];
    yield* Effect.forEach(events, (event) => projections.apply(event), { discard: true });
    const block = (lines: ReadonlyArray<string>, text: string) =>
      ["<t3-replies-mode>", ...lines, "</t3-replies-mode>", text].join("\n");
    const answerWith = (name: string, where: string) =>
      `To answer, call send_to_user with reply_to "${shortId(id(name))}" and the user's words below as user_message. Your answer shows ${where}.`;
    assert.strictEqual(
      yield* deliver({
        threadId: repliesId,
        id: id("q2"),
        text: "And the lint job?",
        under: answerId,
      }),
      `${CHAT_REPLIES_DISPLAY_MODE.notice}\n${block(
        [
          `Message "${shortId(id("q2"))}" from the user, a reply in the sub-thread that showed:`,
          "[you] Yes, all checks pass.",
          answerWith("q2", "in this sub-thread"),
        ],
        "And the lint job?",
      )}`,
    );
    assert.deepStrictEqual(changes, [
      { firstId: answerId, lines: ["[you] Yes, all checks pass.", "[user] And the lint job?"] },
    ]);
    assert.strictEqual(
      yield* deliver({ threadId: repliesId, id: id("other"), text: "Unrelated question." }),
      inMainList(id("other"), "Unrelated question."),
    );
    assert.strictEqual(changes.length, 1);
    // A thread told the rules before they changed gets them again, once.
    yield* sql`UPDATE fork_display_mode_told SET mode_id = 'chat-replies@2' WHERE thread_id = ${repliesId}`;
    assert.strictEqual(
      yield* deliver({ threadId: repliesId, id: id("later"), text: "Ship it." }),
      stated(CHAT_REPLIES_DISPLAY_MODE, inMainList(id("later"), "Ship it.")),
    );
    assert.strictEqual(
      yield* deliver({ threadId: repliesId, id: id("next"), text: "Thanks." }),
      inMainList(id("next"), "Thanks."),
    );
  }).pipe(Effect.provide(Layer.merge(store, wrapper.pipe(Layer.provide(subThreads)))));
});

it.effect("finds in a thread only the text that its display mode shows", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projectId = ProjectId.make("project:display-wrap");
    yield* projects.apply({
      sequence: 0,
      eventId: EventId.make("display-wrap:project"),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(now),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: "Display wrap",
        workspaceRoot: "/workspace",
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(now),
        updatedAt: DateTime.formatIso(now),
      },
    });
    const asked = MessageId.make("message:display-wrap:find:ask");
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      threadCreated(now, sourceId, null),
      runCreated(now, sourceId, runId, "completed"),
      itemUpdated(now, sourceId, runId, 1, {
        type: "user_message",
        messageId: asked,
        text: "Find the needle.",
        inputIntent: "turn_start",
      }),
      itemUpdated(now, sourceId, runId, 2, {
        type: "assistant_message",
        messageId: MessageId.make("message:display-wrap:find:draft"),
        text: "A hidden needle.",
      }),
      itemUpdated(now, sourceId, runId, 3, {
        type: "send_to_user",
        text: "A failed needle.",
        status: "failed",
      }),
      itemUpdated(now, sourceId, runId, 4, { type: "send_to_user", text: "A sent needle." }),
      itemUpdated(now, sourceId, runId, 5, { type: "command_execution" }),
    ];
    yield* Effect.forEach(events, (event) => projections.apply(event), { discard: true });
    const matches = Effect.fn("matches")(function* (displayMode?: string) {
      const result = yield* projections.searchThread({
        threadId: sourceId,
        query: "needle",
        ...(displayMode === undefined ? {} : { displayMode }),
      });
      return result.navigation?.map((entry) => entry.entryId);
    });
    const sentId = `item:${sourceId}:4`;
    const draftId = "message:display-wrap:find:draft";
    assert.deepEqual(yield* matches(), [asked, draftId]);
    assert.deepEqual(yield* matches(NORMAL_DISPLAY_MODE.id), [asked, draftId, sentId]);
    assert.deepEqual(yield* matches(CHAT_REPLIES_DISPLAY_MODE.id), [asked, sentId]);
  }).pipe(
    Effect.provide(
      Layer.merge(ProjectionStore.layer, ProjectStore.layer).pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
      ),
    ),
  ),
);

it.effect("finds a rewritten send by its new text, with the rewrite many rows later", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projectId = ProjectId.make("project:display-wrap");
    yield* projects.apply({
      sequence: 0,
      eventId: EventId.make("display-wrap:project"),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(now),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: "Display wrap",
        workspaceRoot: "/workspace",
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(now),
        updatedAt: DateTime.formatIso(now),
      },
    });
    const notes = Array.from({ length: 200 }, (_, index) =>
      itemUpdated(now, sourceId, runId, 3 + index, {
        type: "user_message",
        messageId: MessageId.make(`message:display-wrap:find:note:${index}`),
        text: `Note ${index}`,
        inputIntent: "steer",
      }),
    );
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      threadCreated(now, sourceId, null),
      runCreated(now, sourceId, runId, "completed"),
      itemUpdated(now, sourceId, runId, 1, {
        type: "user_message",
        messageId: MessageId.make("message:display-wrap:find:ask"),
        text: "Find the needle.",
        inputIntent: "turn_start",
      }),
      itemUpdated(now, sourceId, runId, 2, { type: "send_to_user", text: "A haystack." }),
      ...notes,
      itemUpdated(now, sourceId, runId, 300, {
        type: "replace_send_to_user",
        text: "A rewritten pin.",
      }),
    ];
    yield* Effect.forEach(events, (event) => projections.apply(event), { discard: true });
    const matches = Effect.fn("matches")(function* (query: string, displayMode: string) {
      const result = yield* projections.searchThread({ threadId: sourceId, query, displayMode });
      return result.navigation?.map((entry) => entry.entryId) ?? [];
    });
    const sentId = `item:${sourceId}:2`;
    for (const mode of [NORMAL_DISPLAY_MODE.id, CHAT_REPLIES_DISPLAY_MODE.id]) {
      assert.deepEqual(yield* matches("pin", mode), [sentId]);
      assert.deepEqual(yield* matches("haystack", mode), []);
    }
  }).pipe(
    Effect.provide(
      Layer.merge(ProjectionStore.layer, ProjectStore.layer).pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
      ),
    ),
  ),
);

it.effect("drops the mode and the Dashboard of a deleted thread and keeps the others", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    yield* projections.apply(threadCreated(now, sourceId, null));
    yield* projections.apply(threadCreated(now, deletedId, null));
    yield* projections.apply(threadCreated(now, deletedDashboardId, null));
    yield* sql`UPDATE orchestration_v2_projection_threads
      SET deleted_at = ${DateTime.formatIso(now)}
      WHERE thread_id IN (${deletedId}, ${deletedDashboardId})`;
    yield* DisplayModeWrap.pruneDeletedThreadDisplays();
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const pruned = yield* serverSettings.getSettings;
    // The thread with only a Dashboard entry proves the prune reads both records.
    assert.deepEqual(pruned.threadDashboards, { [dashboardId]: true });
    assert.deepEqual(pruned.threadDisplayModes, {
      [sourceId]: "chat-replies",
      [forkId]: "chat-replies",
      [rolledBackId]: "chat-replies",
      [longId]: "chat-replies",
      [busyId]: "chat-replies",
      [doneId]: "chat-replies",
      [newId]: "chat-replies",
      [rewrittenId]: "chat-replies",
      [repliesId]: "chat-replies",
    });
  }).pipe(Effect.provide(Layer.merge(store, settings))),
);
