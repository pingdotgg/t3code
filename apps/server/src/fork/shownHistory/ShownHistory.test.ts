import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  ComposerContextId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadStreamItem,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2SubscribeThreadInput,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  displayEventFromTurnItem,
  foldCores,
  shortId,
  SUB_THREAD_RECORD_KIND,
} from "@t3tools/shared/displayModes";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Etag, HttpRouter } from "effect/http";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as OrchestrationHttp from "../../orchestration-v2/http.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import { subscribeOrchestrationV2Thread } from "../../ws.ts";
import { selectShownTail } from "./ShownHistory.ts";

const decodeBounded = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot)),
);
const decodeHistoryPage = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadHistoryPage)),
);
const decodeStreamItem = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ThreadStreamItem),
);
const encodeStreamItem = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));

const at = DateTime.makeUnsafe("2026-11-13T00:00:00.000Z");
const provider = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: provider, model: "gpt-5.4" };
const projectId = ProjectId.make("project:shown-history");

const BOT = ThreadId.make("thread:shown:bot");
const PAGED = ThreadId.make("thread:shown:paged");
const REPLIES = ThreadId.make("thread:shown:replies");
const PARENT = ThreadId.make("thread:shown:parent");
const CHILD_SHORT = ThreadId.make("thread:shown:child-short");
const CHILD_LONG = ThreadId.make("thread:shown:child-long");
const CHILD_EDGE = ThreadId.make("thread:shown:child-edge");
const NAMES = ThreadId.make("thread:shown:names");
const GUARD = ThreadId.make("thread:shown:guard");
const QUIET = ThreadId.make("thread:shown:quiet");
const HIDDEN = ThreadId.make("thread:shown:hidden");
const UNANSWERED = ThreadId.make("thread:shown:unanswered");
const LARGE = ThreadId.make("thread:shown:large");
const REWRITES = ThreadId.make("thread:shown:rewrites");
const HUGE = ThreadId.make("thread:shown:huge");

const runIdOf = (threadId: ThreadId, run: number) => RunId.make(`run:${threadId}:${run}`);
const nodeIdOf = (threadId: ThreadId, run: number) => NodeId.make(`node:${threadId}:${run}`);
const itemIdOf = (threadId: ThreadId, run: number, k: number) =>
  TurnItemId.make(`item:${threadId}:${run}:${k}`);
const messageIdOf = (threadId: ThreadId, run: number, k: number) =>
  MessageId.make(`message:${threadId}:${run}:${k}`);

function threadCreated(
  id: ThreadId,
  forkOf?: { readonly threadId: ThreadId; readonly runId: RunId },
): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event:${id}:created`),
    type: "thread.created",
    threadId: id,
    occurredAt: at,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id,
      projectId,
      title: String(id),
      providerInstanceId: provider,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage:
        forkOf === undefined
          ? { parentThreadId: null, relationshipToParent: null, rootThreadId: id }
          : {
              parentThreadId: forkOf.threadId,
              relationshipToParent: "fork",
              rootThreadId: forkOf.threadId,
            },
      forkedFrom: forkOf === undefined ? null : { type: "run", ...forkOf },
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  };
}

function runEvent(
  threadId: ThreadId,
  run: number,
  status: "completed" | "failed" | "rolled_back" = "completed",
): OrchestrationV2DomainEvent {
  const runId = runIdOf(threadId, run);
  return {
    id: EventId.make(`event:${runId}:${status}`),
    type: status === "completed" ? "run.created" : "run.updated",
    threadId,
    runId,
    nodeId: nodeIdOf(threadId, run),
    driver: ProviderDriverKind.make("codex"),
    occurredAt: at,
    payload: {
      id: runId,
      threadId,
      ordinal: run,
      providerInstanceId: provider,
      modelSelection,
      providerThreadId: null,
      userMessageId: messageIdOf(threadId, run, 1),
      rootNodeId: nodeIdOf(threadId, run),
      activeAttemptId: null,
      status,
      requestedAt: at,
      startedAt: at,
      completedAt: at,
      checkpointId: null,
      contextHandoffId: null,
    },
  };
}

const base = (
  threadId: ThreadId,
  run: number,
  k: number,
  status: OrchestrationV2TurnItem["status"] = "completed",
) => ({
  id: itemIdOf(threadId, run, k),
  threadId,
  runId: runIdOf(threadId, run),
  nodeId: nodeIdOf(threadId, run),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  // TurnItemPositionStore numbers a run's items from run * 1_000_000.
  ordinal: run * 1_000_000 + k,
  status,
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
});

type Origin = Pick<
  Extract<OrchestrationV2TurnItem, { type: "user_message" }>,
  "createdBy" | "creationSource" | "scheduledTaskId" | "senderThreadId" | "idleCompaction"
>;
const TYPED: Origin = { createdBy: "user", creationSource: "web" };

const userMessage = (
  threadId: ThreadId,
  run: number,
  k: number,
  text: string,
  origin: Origin = TYPED,
  under?: string,
): OrchestrationV2TurnItem => ({
  ...base(threadId, run, k),
  ...origin,
  type: "user_message",
  messageId: messageIdOf(threadId, run, k),
  inputIntent: "turn_start",
  text,
  attachments: [],
  ...(under === undefined
    ? {}
    : {
        context: {
          version: 1 as const,
          records: [
            {
              version: 1,
              contextId: ComposerContextId.make("fork-reply"),
              kind: SUB_THREAD_RECORD_KIND,
              label: "Reply",
              payload: { first: under },
            },
          ],
        },
      }),
});

const send = (
  threadId: ThreadId,
  run: number,
  k: number,
  text: string,
  options: {
    readonly replyTo?: string;
    readonly toolName?: string;
    readonly status?: OrchestrationV2TurnItem["status"];
    readonly output?: unknown;
  } = {},
): OrchestrationV2TurnItem => ({
  ...base(threadId, run, k, options.status),
  type: "dynamic_tool",
  toolName: options.toolName ?? "mcp__t3-code__send_to_user",
  input: { text, ...(options.replyTo === undefined ? {} : { reply_to: options.replyTo }) },
  ...(options.output === undefined ? {} : { output: options.output }),
});

const rewrite = (
  threadId: ThreadId,
  run: number,
  k: number,
  toolName: string,
  replyTo?: string,
): OrchestrationV2TurnItem => ({
  ...base(threadId, run, k),
  type: "dynamic_tool",
  toolName,
  input: {
    user_message: "",
    old_text: "",
    new_text: replyTo === undefined ? "Rewritten." : `Progress ${run}.`,
    ...(replyTo === undefined ? {} : { reply_to: replyTo }),
  },
});

const hidden = (
  threadId: ThreadId,
  run: number,
  k: number,
  status: OrchestrationV2TurnItem["status"] = "completed",
): OrchestrationV2TurnItem => ({
  ...base(threadId, run, k, status),
  type: "command_execution",
  input: `check ${k}`,
  output: "ok",
  exitCode: 0,
});

const itemEvent = (item: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${item.id}`),
  type: "turn-item.updated",
  threadId: item.threadId,
  ...(item.runId === null ? {} : { runId: item.runId }),
  occurredAt: at,
  payload: item,
});

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

const TYPED_FIRST = itemIdOf(BOT, 1, 1);
const SCHEDULED = itemIdOf(BOT, 15, 23);

/** A typed message, then 30 runs a bot started, with sends in three of them, then 200 hidden rows. */
function botThread(): OrchestrationV2TurnItem[] {
  const items = [
    userMessage(BOT, 1, 1, "Please run the checks and tell me when something needs me."),
    ...range(2, 6).map((k) => hidden(BOT, 1, k)),
    send(BOT, 1, 7, "On it."),
  ];
  for (const run of range(2, 31)) {
    items.push(
      userMessage(BOT, run, 1, `Bot check ${run}.`, { createdBy: "agent", creationSource: "mcp" }),
    );
    items.push(...range(2, 21).map((k) => hidden(BOT, run, k)));
    if (run % 10 === 0) items.push(send(BOT, run, 22, `Check ${run} found nothing.`));
    if (run === 15)
      items.push(
        userMessage(BOT, run, 23, "Nightly task.", {
          createdBy: "user",
          creationSource: "web",
          scheduledTaskId: ScheduledTaskId.make("task:nightly"),
        }),
      );
  }
  items.push(
    userMessage(BOT, 32, 1, "Bot check 32.", { createdBy: "agent", creationSource: "mcp" }),
  );
  items.push(...range(2, 201).map((k) => hidden(BOT, 32, k)));
  return items;
}

/** A typed message, then 300 sends in 30 bot runs, three hidden rows after each. */
function pagedThread(): OrchestrationV2TurnItem[] {
  const items = [userMessage(PAGED, 1, 1, "Start the long job.")];
  for (const run of range(2, 31)) {
    items.push(
      userMessage(PAGED, run, 1, `Bot step ${run}.`, { createdBy: "agent", creationSource: "mcp" }),
    );
    for (const j of range(0, 9)) {
      items.push(send(PAGED, run, 2 + 4 * j, `Step ${run}.${j} done.`));
      items.push(...range(3 + 4 * j, 5 + 4 * j).map((k) => hidden(PAGED, run, k)));
    }
  }
  return items;
}

const FIRST = messageIdOf(REPLIES, 1, 1);
const REPLY_ONE = messageIdOf(REPLIES, 17, 1);
const LONG_TEXT = "The nightly job finished; ".repeat(35);

/**
 * A first message, 15 typed turns with 150 long sends, then two replies under the first message
 * and an agent reply to the first of them.
 */
function repliesThread(): OrchestrationV2TurnItem[] {
  const items = [userMessage(REPLIES, 1, 1, "What failed overnight?")];
  for (const run of range(2, 16)) {
    items.push(userMessage(REPLIES, run, 1, `Check batch ${run}.`));
    for (const j of range(0, 9)) {
      items.push(send(REPLIES, run, 2 + 2 * j, `${LONG_TEXT}${run}.${j}`));
      items.push(hidden(REPLIES, run, 3 + 2 * j));
    }
  }
  items.push(userMessage(REPLIES, 17, 1, "Any failures in the last run?", TYPED, FIRST));
  items.push(send(REPLIES, 17, 2, "None in the last run.", { replyTo: shortId(REPLY_ONE) }));
  items.push(userMessage(REPLIES, 17, 3, "Also check the nightly job.", TYPED, FIRST));
  items.push(...range(4, 10).map((k) => hidden(REPLIES, 17, k)));
  return items;
}

const FORK_RUN = 8;
const ROLLED_BACK_RUN = 5;

/** Ten sends in each of runs 1 to 8, the fork run, and three in each of runs 9 and 10 after it. */
function parentThread(): OrchestrationV2TurnItem[] {
  return range(1, 10).flatMap((run) => [
    ...range(1, run <= FORK_RUN ? 10 : 3).map((k) => send(PARENT, run, k, `Parent ${run}.${k}`)),
    hidden(PARENT, run, 11),
  ]);
}

const childThread = (threadId: ThreadId, runs: number, sends: number) =>
  range(1, runs).flatMap((run) => [
    ...range(1, sends).map((k) => send(threadId, run, k, `Child ${run}.${k}`)),
    hidden(threadId, run, sends + 1),
  ]);

const SEND_NAMES = [
  "send_to_user",
  "replace_send_to_user",
  "mcp__t3-code__send_to_user",
  "mcp__t3_code__replace_send_to_user",
  "mcp__t3code__send_to_user",
  "t3-code.send_to_user",
  "t3_code:send_to_user",
  "t3code/replace_send_to_user",
  "t3-code · send_to_user",
  "t3-code-direct.send_to_user",
  "mcp-t3-code-send_to_user",
  "t3-code-thread_7_send_to_user",
  "send_to_user completed",
  "mcp__t3-code__replace_send_to_user complete",
] as const;

const UNTYPED: ReadonlyArray<Origin> = [
  { createdBy: "agent", creationSource: "mcp" },
  { createdBy: "user", creationSource: "server" },
  { createdBy: "user", creationSource: "web", scheduledTaskId: ScheduledTaskId.make("task:n") },
  { createdBy: "user", creationSource: "web", senderThreadId: ThreadId.make("thread:sender") },
  { createdBy: "user", creationSource: "mobile", idleCompaction: "onReturn" },
];

/** Every send and rewrite name form, then user messages nobody typed, then 100 hidden rows. */
function namesThread(): OrchestrationV2TurnItem[] {
  return [
    userMessage(NAMES, 1, 1, "Report in every way you can."),
    ...SEND_NAMES.flatMap((toolName, index) => [
      toolName.includes("replace")
        ? rewrite(NAMES, 2, 2 * index + 1, toolName)
        : send(NAMES, 2, 2 * index + 1, `Report ${index}.`, { toolName }),
      hidden(NAMES, 2, 2 * index + 2),
    ]),
    ...UNTYPED.flatMap((origin, index) => [
      userMessage(NAMES, 3, 2 * index + 1, `Untyped ${index}.`, origin),
      hidden(NAMES, 3, 2 * index + 2),
    ]),
    ...range(1, 100).map((k) => hidden(NAMES, 4, k)),
  ];
}

const QUESTION = RuntimeRequestId.make("request:shown:question");

/**
 * A pending question in run 1, a typed message and a send in run 2, and in the failed run 3 an
 * error, a running command and more hidden rows after them.
 */
function guardThread(): OrchestrationV2TurnItem[] {
  return [
    {
      ...base(GUARD, 1, 1, "running"),
      type: "user_input_request",
      requestId: QUESTION,
      questions: [{ id: "scope", header: "Scope", question: "Which scope?", options: [] }],
    },
    userMessage(GUARD, 2, 1, "Deploy when ready."),
    send(GUARD, 2, 2, "Deploying."),
    {
      ...base(GUARD, 3, 1, "failed"),
      type: "error",
      failure: {
        class: "provider_error",
        message: "Provider crashed.",
        code: null,
        retryable: false,
      },
    },
    hidden(GUARD, 3, 2, "running"),
    ...range(3, 5).map((k) => hidden(GUARD, 3, k)),
  ];
}

/** Three failed runs, each with an error and work rows, and no message to show. */
const quietThread = () =>
  range(1, 3).flatMap((run): OrchestrationV2TurnItem[] => [
    {
      ...base(QUIET, run, 1, "failed"),
      type: "error",
      failure: {
        class: "provider_error",
        message: `Run ${run} failed.`,
        code: null,
        retryable: false,
      },
    },
    ...range(2, 4).map((k) => hidden(QUIET, run, k)),
  ]);

const REFUSED = { content: [{ type: "text", text: "Too long" }], isError: true };
const UNSENT = ["failed", "cancelled", "interrupted"] as const;
const RUNNING_SEND = itemIdOf(HIDDEN, 3, 641);
const QUEUED = itemIdOf(HIDDEN, 3, 642);

/**
 * One exchange between sends that show nothing: failed ones before it, then 640 refused, failed,
 * cancelled or interrupted ones, a send still running and a queued message that has not started.
 */
const hiddenThread = (): OrchestrationV2TurnItem[] => [
  ...range(1, 3).map((k) => send(HIDDEN, 1, k, `Lost ${k}.`, { status: "failed" })),
  userMessage(HIDDEN, 2, 1, "Is the deploy done?"),
  send(HIDDEN, 2, 2, "Yes, it is live."),
  ...range(1, 640).map((k) =>
    k % 4 === 0
      ? send(HIDDEN, 3, k, `Refused ${k}.`, { output: REFUSED })
      : send(HIDDEN, 3, k, `Unsent ${k}.`, { status: UNSENT[(k % 4) - 1]! }),
  ),
  send(HIDDEN, 3, 641, "Still sending.", { status: "running" }),
  {
    ...base(HIDDEN, 3, 642, "pending"),
    ...TYPED,
    type: "user_message",
    messageId: messageIdOf(HIDDEN, 3, 642),
    inputIntent: "queued_turn",
    text: "Then roll back the canary.",
    attachments: [],
  },
];

/** A first message, 300 sends, then an agent reply whose reply_to names no message. */
const unansweredThread = () => [
  userMessage(UNANSWERED, 1, 1, "Watch the queue."),
  ...range(2, 31).flatMap((run) =>
    range(1, 10).map((k) => send(UNANSWERED, run, k, `Queue ${run}.${k} is fine.`)),
  ),
  send(UNANSWERED, 32, 1, "Answering a message that is not there.", { replyTo: "zzzzzz" }),
];

const REWRITTEN_ANSWER = shortId(messageIdOf(REWRITES, 1, 1));

/** A typed message and its answer, then 200 bot runs that each rewrite that answer. */
const rewritesThread = () => [
  userMessage(REWRITES, 1, 1, "Tell me how the long job goes."),
  send(REWRITES, 1, 2, "Started.", { replyTo: REWRITTEN_ANSWER }),
  ...range(2, 201).map((run) =>
    rewrite(REWRITES, run, 1, "mcp__t3-code__replace_send_to_user", REWRITTEN_ANSWER),
  ),
];

const LARGE_TEXT = "A full report line. ".repeat(512);

/** A typed message and 150 sends of about 10 KiB each, one per run. */
const largeThread = () => [
  userMessage(LARGE, 1, 1, "Send the full reports."),
  ...range(2, 151).map((run) => send(LARGE, run, 1, `${LARGE_TEXT}${run}`)),
];

const HUGE_TEXT = "x".repeat(5 * 1_048_576);

/** A typed message and seven sends of 5 MiB each, more than a tail read holds. */
const hugeThread = () => [
  userMessage(HUGE, 1, 1, "Paste the logs."),
  ...range(2, 8).map((run) => send(HUGE, run, 1, `${HUGE_TEXT}${run}`)),
];

/** Forks of PARENT: label, thread, runs, sends per run, and the thread the window's cursor is in. */
const CHILDREN = [
  ["a child with fewer shown rows than the window holds", CHILD_SHORT, 9, 10, PARENT],
  ["a child with more shown rows than the window holds", CHILD_LONG, 13, 10, CHILD_LONG],
  // 128 rows: the walk's fourth batch both meets the window's needs and ends the child.
  ["a child whose shown rows end on a batch boundary", CHILD_EDGE, 16, 8, PARENT],
] as const;

const runsOf = (items: ReadonlyArray<OrchestrationV2TurnItem>) => [
  ...new Set(items.map((item) => Number(String(item.runId).split(":").at(-1)))),
];

const seed = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads: ReadonlyArray<
    readonly [ThreadId, ReadonlyArray<OrchestrationV2TurnItem>, ReturnType<typeof threadCreated>]
  > = [
    [BOT, botThread(), threadCreated(BOT)],
    [PAGED, pagedThread(), threadCreated(PAGED)],
    [REPLIES, repliesThread(), threadCreated(REPLIES)],
    [PARENT, parentThread(), threadCreated(PARENT)],
    ...CHILDREN.map(
      ([, child, runs, sends]) =>
        [
          child,
          childThread(child, runs, sends),
          threadCreated(child, { threadId: PARENT, runId: runIdOf(PARENT, FORK_RUN) }),
        ] as const,
    ),
    [NAMES, namesThread(), threadCreated(NAMES)],
    [GUARD, guardThread(), threadCreated(GUARD)],
    [QUIET, quietThread(), threadCreated(QUIET)],
    [HIDDEN, hiddenThread(), threadCreated(HIDDEN)],
    [UNANSWERED, unansweredThread(), threadCreated(UNANSWERED)],
    [LARGE, largeThread(), threadCreated(LARGE)],
    [REWRITES, rewritesThread(), threadCreated(REWRITES)],
    [HUGE, hugeThread(), threadCreated(HUGE)],
  ];
  for (const [threadId, items, created] of threads) {
    yield* projections.apply(created);
    for (const run of runsOf(items)) yield* projections.apply(runEvent(threadId, run));
    for (const item of items) yield* projections.apply(itemEvent(item));
  }
  yield* projections.apply(runEvent(PARENT, ROLLED_BACK_RUN, "rolled_back"));
  yield* projections.apply(runEvent(GUARD, 3, "failed"));
  for (const run of range(1, 3)) yield* projections.apply(runEvent(QUIET, run, "failed"));
  yield* projections.apply({
    id: EventId.make("event:shown:question"),
    type: "runtime-request.updated",
    threadId: GUARD,
    nodeId: nodeIdOf(GUARD, 1),
    occurredAt: at,
    payload: {
      id: QUESTION,
      nodeId: nodeIdOf(GUARD, 1),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: at,
      resolvedAt: null,
    },
  });
});

const store = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const management = Layer.unwrap(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return Layer.mock(ThreadManagementService.ThreadManagementService)({
      ensureLegacyTranscript: () => Effect.void,
      getThreadSnapshot: (id) => projections.getThreadSnapshot(id).pipe(Effect.orDie),
      getThreadSnapshotWindow: (id, options) =>
        projections.getThreadSnapshotWindow(id, options).pipe(Effect.orDie),
      getThreadHistoryPage: (id, cursor, throughEntryId, conversationOnly, workMode) =>
        projections
          .getThreadHistoryPage(id, cursor, throughEntryId, conversationOnly, workMode)
          .pipe(Effect.orDie),
      streamStoredEventsFrom: () => Stream.empty,
    });
  }),
);

class OrchestrationApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.orchestration,
) {}
const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
  effect.pipe(
    Effect.provideService(EnvironmentAuthenticatedPrincipal, {
      sessionId: AuthSessionId.make("shown-history"),
      subject: "shown-history",
      method: "browser-session-cookie",
      scopes: new Set([AuthOrchestrationReadScope]),
    }),
  ),
);

const TestLayer = Layer.mergeAll(
  management,
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("shown-history")),
  }),
  Layer.effectDiscard(seed),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(ProjectStore.ProjectStoreV2)({}),
  Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({}),
).pipe(Layer.provideMerge(store));

const withHttp = <A>(use: (get: (path: string) => Promise<Response>) => Promise<A>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Layer.Success<typeof TestLayer>>();
    const appLayer = HttpApiBuilder.layer(OrchestrationApi).pipe(
      Layer.provide(OrchestrationHttp.layer),
      Layer.provide(auth),
      Layer.provide(Layer.succeedContext(context)),
      Layer.provide(NodeHttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(appLayer, { disableLogger: true })),
      ({ handler }) =>
        Effect.promise(() =>
          use((path) =>
            handler(
              new Request(`http://environment.test${path}`, {
                headers: {
                  [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
                },
              }),
            ),
          ),
        ),
      ({ dispose }) => Effect.promise(() => dispose()),
    );
  });

/** The first snapshot of a subscription, as the client decodes it. */
const firstSnapshot = (input: OrchestrationV2SubscribeThreadInput) =>
  subscribeOrchestrationV2Thread(input).pipe(
    Effect.flatMap((stream) => Stream.runHead(stream)),
    Effect.map((head) => {
      if (head._tag !== "Some" || head.value.kind !== "snapshot") throw new Error("No snapshot");
      const decoded = decodeStreamItem(JSON.parse(JSON.stringify(encodeStreamItem(head.value))));
      if (decoded.kind !== "snapshot") throw new Error("No snapshot");
      return decoded;
    }),
  );

const shownSnapshot = (threadId: ThreadId) =>
  firstSnapshot({ threadId, acceptBoundedSnapshot: true, shownOnly: true });

const cursorRow = (cursor: string | null | undefined) =>
  cursor == null ? null : String(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")).si);
const cursorThread = (cursor: string | null | undefined) =>
  cursor == null ? null : String(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")).st);

const historyPath = (threadId: ThreadId, cursor: string, throughEntryId?: string) =>
  `/api/orchestration/threads/${encodeURIComponent(threadId)}/history?cursor=${encodeURIComponent(cursor)}${throughEntryId === undefined ? "" : `&throughEntryId=${encodeURIComponent(throughEntryId)}`}`;

const fetchPage = (get: (path: string) => Promise<Response>, path: string) =>
  get(path).then(async (response) => {
    assert.strictEqual(response.status, 200);
    return decodeHistoryPage(await response.text());
  });

/** Every older page from `cursor` on, one request each. */
const allPages = (threadId: ThreadId, cursor: string | null | undefined) =>
  withHttp(async (get) => {
    const pages: Array<ReturnType<typeof decodeHistoryPage>> = [];
    for (let next = cursor ?? null; next !== null;) {
      const page = await fetchPage(get, historyPath(threadId, next));
      pages.push(page);
      next = page.nextCursor;
    }
    return pages;
  });

const visibleIds = (projection: OrchestrationV2ThreadProjection) =>
  projection.visibleTurnItems.map((row) => String(row.sourceItemId));

const isShownItem = (item: OrchestrationV2TurnItem) => {
  const event = displayEventFromTurnItem(item);
  return event?.type === "user" || event?.type === "sent" || event?.type === "rewrite";
};

/** The ids of `items` that a display mode shows, oldest first. */
const shownIdsOf = (items: ReadonlyArray<OrchestrationV2TurnItem>) =>
  items.filter(isShownItem).map((item) => String(item.id));

it.layer(TestLayer)("shown-only history", (it) => {
  it.effect("a shown subscription opens a bot-heavy thread on its messages", () =>
    Effect.gen(function* () {
      const snapshot = yield* shownSnapshot(BOT);
      const projection = boundedSnapshotProjection(snapshot);
      const shown = projection.visibleTurnItems.filter((row) => isShownItem(row.item));

      assert.deepStrictEqual(
        shown.map((row) => String(row.sourceItemId)),
        shownIdsOf(botThread()),
      );
      assert.include(visibleIds(projection), String(TYPED_FIRST));
      assert.notInclude(visibleIds(projection), String(SCHEDULED));
      assert.isFalse(snapshot.hasMoreHistory);
      assert.isNull(snapshot.historyCursor);
    }),
  );

  it.effect("older shown pages hold only shown rows, in order, and end history", () =>
    Effect.gen(function* () {
      const snapshot = yield* shownSnapshot(PAGED);
      const window = boundedSnapshotProjection(snapshot).visibleTurnItems.filter((row) =>
        isShownItem(row.item),
      );
      assert.isTrue(snapshot.hasMoreHistory);
      const pages = yield* allPages(PAGED, snapshot.historyCursor);

      for (const page of pages) {
        assert.isTrue(page.items.every((row) => isShownItem(row.item)));
      }
      for (const page of pages.slice(0, -1)) {
        assert.isAtLeast(page.items.length, 100, "a page that is not the last holds 100 messages");
      }
      assert.isFalse(pages.at(-1)!.hasMoreHistory);
      assert.isNull(pages.at(-1)!.nextCursor);
      const loaded = [...pages.toReversed().flatMap((page) => page.items), ...window].map((row) =>
        String(row.sourceItemId),
      );
      assert.deepStrictEqual(loaded, shownIdsOf(pagedThread()));
    }),
  );

  it.effect("the window brings the first message of every loaded reply", () =>
    Effect.gen(function* () {
      const projection = boundedSnapshotProjection(yield* shownSnapshot(REPLIES));
      const cores = foldCores(
        projection.visibleTurnItems.flatMap((row) => {
          const event = displayEventFromTurnItem(row.item);
          return event === null ? [] : [event];
        }),
      );
      const loaded = new Set(cores.map((core) => core.id));
      const replies = cores.filter((core) => core.reply);

      assert.strictEqual(replies.length, 3);
      assert.isTrue(replies.every((core) => core.first === FIRST));
      assert.isTrue(loaded.has(FIRST));
    }),
  );

  describe.each(CHILDREN)("%s", (_, child, runs, sends, cursorIn) => {
    it.effect("reads its parent up to the fork run, rolled-back runs included", () =>
      Effect.gen(function* () {
        const snapshot = yield* shownSnapshot(child);
        assert.strictEqual(cursorThread(snapshot.historyCursor), String(cursorIn));
        const window = boundedSnapshotProjection(snapshot).visibleTurnItems.filter((row) =>
          isShownItem(row.item),
        );
        const pages = yield* allPages(child, snapshot.historyCursor);
        const loaded = [...pages.toReversed().flatMap((page) => page.items), ...window];

        const inherited = parentThread().filter((item) => runOrdinalOf(item) <= FORK_RUN);
        assert.deepStrictEqual(
          loaded.map((row) => String(row.sourceItemId)),
          [...shownIdsOf(inherited), ...shownIdsOf(childThread(child, runs, sends))],
        );
        assert.isTrue(
          loaded.every(
            (row) => (row.sourceThreadId === PARENT) === (row.visibility === "inherited"),
          ),
        );
        assert.isTrue(loaded.some((row) => runOrdinalOf(row.item) === ROLLED_BACK_RUN));
        assert.isFalse(pages.at(-1)?.hasMoreHistory ?? snapshot.hasMoreHistory);
      }),
    );
  });

  it.effect(
    "a targeted page reads in one request until it has passed its target, and no further",
    () =>
      Effect.gen(function* () {
        const snapshot = yield* shownSnapshot(PAGED);
        const cursor = snapshot.historyCursor ?? "";
        const inWindow = new Set(visibleIds(boundedSnapshotProjection(snapshot)));
        const sendFarBack = shownIdsOf(pagedThread()).at(-280)!;
        const workRow = itemIdOf(PAGED, 6, 3);
        const pages = yield* withHttp(async (get) => ({
          plain: await fetchPage(get, historyPath(PAGED, cursor)),
          send: await fetchPage(get, historyPath(PAGED, cursor, sendFarBack)),
          work: await fetchPage(get, historyPath(PAGED, cursor, workRow)),
          missing: await fetchPage(get, historyPath(PAGED, cursor, "item:in-no-thread")),
        }));
        const idsOf = (page: typeof pages.plain) =>
          page.items.map((row) => String(row.sourceItemId));

        assert.notInclude(idsOf(pages.plain), sendFarBack);
        assert.include(idsOf(pages.send), sendFarBack);
        assert.includeMembers(
          idsOf(pages.work),
          pagedThread()
            .filter(
              (item) => isShownItem(item) && item.ordinal > 6_000_003 && !inWindow.has(item.id),
            )
            .map((item) => String(item.id)),
          "every shown row between the cursor and a work row",
        );
        assert.isTrue(pages.work.hasMoreHistory, "the walk stops once it has passed the work row");
        assert.deepStrictEqual(pages.missing, pages.plain, "a row in no thread is no target");
        for (const page of Object.values(pages)) {
          assert.isTrue(page.items.every((row) => isShownItem(row.item)));
        }
      }),
  );

  it.effect("rows that show nothing are neither sent, counted, nor a cursor", () =>
    Effect.gen(function* () {
      const snapshot = yield* shownSnapshot(HIDDEN);
      const projection = boundedSnapshotProjection(snapshot);
      const items = projection.turnItems.map((item) => String(item.id));

      assert.deepStrictEqual(
        projection.visibleTurnItems
          .filter((row) => isShownItem(row.item))
          .map((row) => String(row.sourceItemId)),
        shownIdsOf(hiddenThread()),
      );
      assert.isFalse(snapshot.hasMoreHistory);
      assert.isNull(snapshot.historyCursor);
      assert.include(items, String(RUNNING_SEND), "the running send");
      assert.include(items, String(QUEUED), "the queued message");
    }),
  );

  it.effect("an agent reply to no message stops needing one after the window's messages", () =>
    Effect.gen(function* () {
      const snapshot = yield* shownSnapshot(UNANSWERED);
      const cores = foldCores(
        boundedSnapshotProjection(snapshot).visibleTurnItems.flatMap((row) => {
          const event = displayEventFromTurnItem(row.item);
          return event === null ? [] : [event];
        }),
      );

      assert.isTrue(cores.at(-1)?.reply, "the reply is in the window");
      assert.isBelow(cores.length, 200, "the window does not walk on for the reply");
      assert.isTrue(snapshot.hasMoreHistory);
    }),
  );

  it.effect("older rewrites of a message a newer rewrite sets do not fill the window", () =>
    Effect.gen(function* () {
      const snapshot = yield* shownSnapshot(REWRITES);
      const items = boundedSnapshotProjection(snapshot).visibleTurnItems;
      const cores = foldCores(
        items.flatMap((row) => {
          const event = displayEventFromTurnItem(row.item);
          return event === null ? [] : [event];
        }),
      );

      assert.deepStrictEqual(
        cores.map((core) => core.text),
        ["Tell me how the long job goes.", "Progress 201."],
      );
      assert.isFalse(snapshot.hasMoreHistory);
    }),
  );

  it.effect("a window stopped by its byte cap pages on from the first row it left out", () =>
    Effect.gen(function* () {
      const snapshot = yield* shownSnapshot(LARGE);
      const window = boundedSnapshotProjection(snapshot).visibleTurnItems.filter((row) =>
        isShownItem(row.item),
      );
      const shown = shownIdsOf(largeThread());
      const pages = yield* allPages(LARGE, snapshot.historyCursor);

      assert.isBelow(window.length, 120, "the cap, not the message count, ends the window");
      assert.strictEqual(cursorRow(snapshot.historyCursor), shown.at(-window.length - 1));
      assert.isAbove(pages.length, 1);
      assert.deepStrictEqual(
        [...pages.toReversed().flatMap((page) => page.items), ...window].map((row) =>
          String(row.sourceItemId),
        ),
        shown,
      );
    }),
  );

  it.effect("a tail read reaches back past the window's messages and says why it stopped", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tail = (threadId: ThreadId, minCores: number) =>
        selectShownTail(sql, threadId, ProjectionStore.inheritedRunFork, minCores);
      const ids = (rows: ReadonlyArray<{ readonly itemId: TurnItemId }>) =>
        rows.map((row) => String(row.itemId));
      const paged = shownIdsOf(pagedThread());

      const enough = yield* tail(PAGED, 240);
      assert.strictEqual(enough?.stop, "enough");
      assert.isAtLeast(enough!.rows.length, 240);
      assert.isBelow(enough!.rows.length, paged.length);
      assert.deepStrictEqual(ids(enough!.rows), paged.slice(-enough!.rows.length));

      const start = yield* tail(PAGED, 400);
      assert.strictEqual(start?.stop, "start");
      assert.deepStrictEqual(ids(start!.rows), paged);

      const cap = yield* tail(HUGE, 240);
      assert.strictEqual(cap?.stop, "cap");
      assert.deepStrictEqual(ids(cap!.rows), shownIdsOf(hugeThread()).slice(-cap!.rows.length));
      assert.isBelow(cap!.rows.length, hugeThread().length);

      assert.isNull(yield* tail(ThreadId.make("thread:shown:missing"), 240));
    }),
  );

  it.effect("HTTP shownOnly returns the socket snapshot's rows and cursor", () =>
    Effect.gen(function* () {
      const flags = { compactTurnItems: true, dedupeBodies: true, compactIds: true };
      const socket = yield* firstSnapshot({
        threadId: PAGED,
        acceptBoundedSnapshot: true,
        acceptDeferredWork: true,
        acceptCompactTurnItems: flags.compactTurnItems,
        acceptDedupedBodies: flags.dedupeBodies,
        acceptCompactIds: flags.compactIds,
        shownOnly: true,
      });
      const http = yield* withHttp(async (get) =>
        decodeBounded(
          await (
            await get(
              `/api/orchestration/threads/${encodeURIComponent(PAGED)}/bounded?compactTurnItems=1&dedupeBodies=1&compactIds=1&deferWork=1&shownOnly=1`,
            )
          ).text(),
        ),
      );
      const socketRows = boundedSnapshotProjection(socket).visibleTurnItems;

      assert.deepStrictEqual(
        visibleIds(boundedSnapshotProjection(http)),
        socketRows.map((row) => String(row.sourceItemId)),
      );
      assert.strictEqual(http.historyCursor, socket.historyCursor);
      assert.strictEqual(http.hasMoreHistory, socket.hasMoreHistory);
      assert.strictEqual(http.latestLocalTurnOrdinal, socket.latestLocalTurnOrdinal);
      assert.isTrue(
        socketRows.slice(0, -1).every((row) => isShownItem(row.item)),
        "every row but the newest is a shown row",
      );
    }),
  );

  it.effect(
    "a send or rewrite under any accepted tool name is shown; untyped messages are not",
    () =>
      Effect.gen(function* () {
        const ids = visibleIds(boundedSnapshotProjection(yield* shownSnapshot(NAMES)));
        const items = namesThread();

        for (const [index, toolName] of SEND_NAMES.entries()) {
          assert.isNotNull(resolveT3McpToolId(toolName), toolName);
          assert.include(ids, String(itemIdOf(NAMES, 2, 2 * index + 1)), toolName);
        }
        for (const item of items.filter((item) => runOrdinalOf(item) === 3)) {
          if (item.type === "user_message") assert.notInclude(ids, String(item.id));
        }
      }),
  );

  it.effect("the shown window keeps what the screen needs beside the messages", () =>
    Effect.gen(function* () {
      const snapshot = yield* shownSnapshot(GUARD);
      const projection = boundedSnapshotProjection(snapshot);
      const ids = projection.turnItems.map((item) => String(item.id));

      assert.include(ids, String(itemIdOf(GUARD, 1, 1)), "the pending question card");
      assert.include(ids, String(itemIdOf(GUARD, 3, 1)), "the failed error");
      assert.include(ids, String(itemIdOf(GUARD, 3, 2)), "the running command");
      assert.include(ids, String(itemIdOf(GUARD, 3, 5)), "the newest row");
      assert.strictEqual(snapshot.latestLocalTurnOrdinal, 3_000_005);
    }),
  );

  it.effect("a window with no shown row of its own keeps only the latest run's errors", () =>
    Effect.gen(function* () {
      const ids = boundedSnapshotProjection(yield* shownSnapshot(QUIET)).turnItems.map((item) =>
        String(item.id),
      );

      assert.include(ids, String(itemIdOf(QUIET, 3, 1)));
      assert.notInclude(ids, String(itemIdOf(QUIET, 2, 1)));
      assert.notInclude(ids, String(itemIdOf(QUIET, 1, 1)));
    }),
  );

  it.effect("a subscription without shownOnly keeps the Normal window and pages", () =>
    Effect.gen(function* () {
      const snapshot = yield* firstSnapshot({ threadId: BOT, acceptBoundedSnapshot: true });
      const cursor = snapshot.historyCursor ?? "";
      const page = yield* withHttp((get) => fetchPage(get, historyPath(BOT, cursor)));

      assert.isTrue(
        boundedSnapshotProjection(snapshot).visibleTurnItems.some((row) => !isShownItem(row.item)),
      );
      assert.notProperty(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")), "fv");
      assert.isTrue(page.items.some((row) => !isShownItem(row.item)));
    }),
  );
});

function runOrdinalOf(item: Pick<OrchestrationV2TurnItem, "ordinal">): number {
  return Math.floor(item.ordinal / 1_000_000);
}
