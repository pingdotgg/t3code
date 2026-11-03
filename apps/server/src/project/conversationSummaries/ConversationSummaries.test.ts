import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ComposerContextId,
  ConversationSummary,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectFactId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ServerSettings as ServerSettingsSchema,
  TextGenerationError,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { historyCost } from "@t3tools/provider-core/server/handoffBudget";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../mcp/McpToolAccess.testkit.ts";
import * as SummaryHandlers from "../../mcp/toolkits/conversationSummaries/handlers.ts";
import { ConversationSummariesToolkit } from "../../mcp/toolkits/conversationSummaries/tools.ts";
import { deliverContextHandoffs } from "../../orchestration-v2/ContextHandoffDelivery.ts";
import * as ContextHandoffService from "../../orchestration-v2/ContextHandoffService.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../../orchestration-v2/ProjectionMaintenance.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as HolographicMemory from "../knowledge/HolographicMemory.ts";
import * as ProjectKnowledge from "../knowledge/ProjectKnowledge.ts";
import { deliveredKnowledgeForHistory } from "../knowledge/composer.ts";
import * as ConversationSummaries from "./ConversationSummaries.ts";
import { conversationSummaryEffects } from "./conversationSummarySchedule.ts";

type Generate = TextGeneration.TextGeneration["Service"]["generateConversationSummary"];

const projectId = ProjectId.make("summary-project");
const threadId = ThreadId.make("summary-thread");
const instanceId = ProviderInstanceId.make("codex");
const runId = RunId.make("summary-run");
const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 22));
const scope = { projectId, threadId };
const optedIn = {
  projectSettingsOverrides: { [projectId]: { enableConversationSummaries: true } },
};
const decodeSettings = Schema.decodeUnknownEffect(ServerSettingsSchema);
const encodeSummary = Schema.encodeEffect(Schema.fromJsonString(ConversationSummary));
// 8 exchanges: the first 10 messages are settled, the last 6 are the fresh tail.
const MESSAGE_COUNT = 16;

const rawText = (index: number) =>
  `${index % 2 === 0 ? "Request" : "Reply"} ${index}: keep 日本語 🧪 exact.\n  ${"Detail. ".repeat(120)}`;

const scripted = (reply: (input: Parameters<Generate>[0]) => ReturnType<Generate>) => {
  const calls: Array<Parameters<Generate>[0]> = [];
  const generate: Generate = (input) => {
    calls.push(input);
    return reply(input);
  };
  return { calls, generate };
};
// Cites the first and last message of whatever it was given, plus one ref it made up.
const citing = () =>
  scripted((input) =>
    Effect.succeed({
      statements: [
        {
          text: "The user asked for exact text handling; the agent reported it done.",
          citations: [input.messages[0]!.ref, input.messages.at(-1)!.ref, "M999"],
        },
        { text: "An unsupported statement.", citations: ["M999"] },
      ],
    }),
  );

const makeLayer = (generate: Generate, settings: Parameters<typeof ServerSettings.layerTest>[0]) =>
  Layer.merge(ConversationSummaries.layer, ContextHandoffService.layer).pipe(
    Layer.provide(
      Layer.mock(TextGeneration.TextGeneration)({ generateConversationSummary: generate }),
    ),
    Layer.provide(IdAllocator.layer),
    Layer.provideMerge(ProjectKnowledge.layer.pipe(Layer.provide(HolographicMemory.layer))),
    Layer.provideMerge(
      Layer.mergeAll(
        ProjectStore.layer,
        ProjectionStore.layer,
        ThreadSearch.layer,
        ProjectionMaintenance.layer.pipe(
          Layer.provideMerge(EventStore.layer),
          Layer.provide(ProjectionStore.layer),
        ),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest(settings)),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("summary-environment")),
      }),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const messageId = (index: number) => MessageId.make(`message-${index}`);
const itemId = (index: number) => TurnItemId.make(`item-${index}`);

const messageEvent = (index: number, text: string): OrchestrationV2DomainEvent => ({
  id: EventId.make(`message-${index}-${text.length}`),
  type: "message.updated",
  threadId,
  providerInstanceId: instanceId,
  occurredAt: at,
  payload: {
    createdBy: index % 2 === 0 ? "user" : "agent",
    creationSource: index % 2 === 0 ? "web" : "provider",
    id: messageId(index),
    threadId,
    runId,
    nodeId: null,
    role: index % 2 === 0 ? "user" : "assistant",
    text,
    streaming: false,
    attachments: [],
    createdAt: DateTime.add(at, { minutes: index }),
    updatedAt: at,
  },
});

const item = (index: number): OrchestrationV2TurnItem => {
  const base = {
    id: itemId(index),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: index,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    messageId: messageId(index),
    text: rawText(index),
  };
  return index % 2 === 0
    ? {
        ...base,
        type: "user_message",
        createdBy: "user",
        creationSource: "web",
        inputIntent: "turn_start",
        attachments: [],
      }
    : { ...base, type: "assistant_message", streaming: false };
};

const threadPayload = {
  createdBy: "user" as const,
  creationSource: "web" as const,
  id: threadId,
  projectId,
  title: "Summary thread",
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "gpt-5" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};

const seedThread = Effect.fn("test.seedSummaryThread")(function* (messageCount: number) {
  const projects = yield* ProjectStore.ProjectStoreV2;
  yield* projects.apply({
    sequence: 0,
    eventId: EventId.make("project-created"),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: DateTime.formatIso(at),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Summary project",
      workspaceRoot: "/work/summary",
      defaultModelSelection: null,
      scripts: [],
      createdAt: DateTime.formatIso(at),
      updatedAt: DateTime.formatIso(at),
    },
  });
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* EventStore.EventStoreV2;
  const apply = Effect.fn("test.persistSummarySource")(function* (
    event: OrchestrationV2DomainEvent,
  ) {
    yield* events.append({ events: [event] });
    yield* projections.apply(event);
  });
  yield* apply({
    id: EventId.make("thread-created"),
    type: "thread.created",
    threadId,
    providerInstanceId: instanceId,
    occurredAt: at,
    payload: threadPayload,
  });
  for (let index = 0; index < messageCount; index++) {
    yield* apply(messageEvent(index, rawText(index)));
    yield* apply({
      id: EventId.make(`item-${index}`),
      type: "turn-item.updated",
      threadId,
      providerInstanceId: instanceId,
      occurredAt: at,
      payload: item(index),
    });
  }
});
const seed = seedThread(MESSAGE_COUNT);

const persistSummary = Effect.fn("test.persistSummary")(function* (
  index: number,
  sourceIndexes: ReadonlyArray<number>,
  stale = false,
) {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Digest.Digest;
  const sources = yield* Effect.forEach(sourceIndexes, (sourceIndex) =>
    crypto.digest(Digest.sha256, new TextEncoder().encode(rawText(sourceIndex))).pipe(
      Effect.map((digest) => ({
        kind: "message" as const,
        threadId,
        messageId: messageId(sourceIndex),
        digest: stale ? "0".repeat(64) : Hex.encode(digest),
      })),
    ),
  );
  const summary: ConversationSummary = {
    id: `summary:${index.toString(16).padStart(64, "0")}`,
    ...scope,
    sources,
    statements: [{ text: `Summary ${index}`, citations: [sources[0]!.messageId] }],
    modelSelection: { instanceId, model: "gpt-5" },
    createdAt: DateTime.formatIso(at),
  };
  const payloadJson = yield* encodeSummary(summary);
  yield* sql`
    INSERT INTO conversation_summaries (
      summary_id, project_id, thread_id, first_source_at, created_at, payload_json
    ) VALUES (
      ${summary.id}, ${projectId}, ${threadId},
      ${DateTime.formatIso(DateTime.add(at, { minutes: sourceIndexes[0]! }))},
      ${summary.createdAt}, ${payloadJson}
    )
  `;
  return summary;
});

const prepareHandoff = Effect.fn("test.prepareSummaryHandoff")(function* (messageCount: number) {
  const handoffs = yield* ContextHandoffService.ContextHandoffServiceV2;
  return yield* handoffs.prepareProviderHandoff({
    threadId,
    targetRunId: RunId.make("summary-target-run"),
    transferId: null,
    fromProviderThreadIds: [],
    toProviderThreadId: providerThread.id,
    fromProviderInstanceId: instanceId,
    toProviderInstanceId: instanceId,
    coveredRunOrdinals: { from: 1, to: 1 },
    strategy: "full_thread_summary",
    items: Array.from({ length: messageCount }, (_, index) => item(index)),
    createdAt: at,
  });
});

const summarize = Effect.flatMap(ConversationSummaries.ConversationSummaries, (service) =>
  service.summarizeThread({ threadId, runId }),
);
const list = Effect.flatMap(ConversationSummaries.ConversationSummaries, (service) =>
  service.list(scope),
);
const onlySummary = Effect.gen(function* () {
  const result = yield* list;
  assert.equal(result.summaries.length, 1);
  const [read] = result.summaries;
  if (read?.state !== "available") throw new Error("Expected an available summary");
  return read.summary;
});

it.effect(
  "summarizes the settled range once with exact citations and no stored source text",
  () => {
    const model = citing();
    return Effect.gen(function* () {
      yield* seed;
      yield* summarize;
      yield* summarize;
      assert.equal(model.calls.length, 1);
      assert.deepEqual(
        model.calls[0]!.messages.map((message) => message.ref),
        Array.from({ length: 10 }, (_, index) => `M${index + 1}`),
      );
      const summary = yield* onlySummary;
      assert.deepEqual(
        summary.sources.map((source) => source.messageId),
        Array.from({ length: 10 }, (_, index) => messageId(index)),
      );
      // Only cited refs survive, mapped to the exact message ids; the invented ref is dropped.
      assert.deepEqual(summary.statements, [
        {
          text: "The user asked for exact text handling; the agent reported it done.",
          citations: [messageId(0), messageId(9)],
        },
      ]);
      const result = yield* list;
      assert.isTrue(result.enabled);
      assert.deepInclude(result.lastPass, { result: "skipped", generated: 0, waitingMessages: 0 });
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM conversation_summaries
    `;
      assert.isTrue(rows.every((row) => !row.payload_json.includes("Detail. Detail.")));
    }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
  },
);

it.effect("schedules and generates nothing for a project that has not opted in", () => {
  const model = citing();
  return Effect.gen(function* () {
    assert.deepEqual(
      conversationSummaryEffects({ settings: DEFAULT_SERVER_SETTINGS, projectId, threadId, runId }),
      [],
    );
    const settings = yield* decodeSettings(optedIn);
    assert.deepEqual(
      conversationSummaryEffects({ settings, projectId, threadId, runId }).map(
        (effect) => effect.id,
      ),
      [`effect:conversation-summary.generate:${runId}`],
    );
    yield* seed;
    // A pass already queued when the project opted out runs, but does nothing.
    yield* summarize;
    assert.equal(model.calls.length, 0);
    const result = yield* list;
    assert.isFalse(result.enabled);
    assert.deepEqual(result.summaries, []);
    assert.deepInclude(result.lastPass, { result: "skipped" });
  }).pipe(Effect.provide(makeLayer(model.generate, {})));
});

it.effect("records an unavailable model as a failed pass without publishing a summary", () => {
  const model = scripted(() =>
    Effect.fail(
      new TextGenerationError({ operation: "generateConversationSummary", detail: "No model" }),
    ),
  );
  return Effect.gen(function* () {
    yield* seed;
    yield* summarize;
    const result = yield* list;
    assert.deepEqual(result.summaries, []);
    assert.deepInclude(result.lastPass, {
      result: "failed",
      reason: "No model",
      waitingMessages: 10,
    });
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect("continues coverage and handoff lookup beyond the first 500 summaries", () => {
  const model = citing();
  return Effect.gen(function* () {
    // Short closed stretches are valid leaves. Keep enough to cross the SQL page boundary,
    // followed by ten uncovered settled messages and the six-message verbatim tail.
    const summaryCount = 501;
    const coveredMessages = summaryCount * 2;
    const messageCount = coveredMessages + 10 + 6;
    yield* seedThread(messageCount);
    for (let index = 0; index < summaryCount; index++)
      yield* persistSummary(index, [index * 2, index * 2 + 1]);

    yield* summarize;
    yield* summarize;
    assert.equal(model.calls.length, 1);
    assert.equal(model.calls[0]!.messages[0]!.text, rawText(coveredMessages));
    assert.deepInclude((yield* list).lastPass, { generated: 0, waitingMessages: 0 });

    const service = yield* ConversationSummaries.ConversationSummaries;
    const handoff = yield* prepareHandoff(messageCount);
    const offered = yield* service.forHandoff({
      projectId,
      handoffs: [handoff],
      itemIds: new Set([itemId(coveredMessages - 2), itemId(coveredMessages - 1)]),
    });
    assert.deepEqual(
      offered.map((summary) => summary.coveredItemIds),
      [[itemId(coveredMessages - 2), itemId(coveredMessages - 1)]],
    );
    assert.include(offered[0]!.text, "Summary 500");
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect("does not spend the handoff candidate limit on stale summaries", () => {
  const model = citing();
  return Effect.gen(function* () {
    yield* seed;
    const sourceIndexes = Array.from({ length: 10 }, (_, index) => index);
    for (let index = 0; index < 40; index++) yield* persistSummary(index, sourceIndexes, true);
    const current = yield* persistSummary(40, sourceIndexes);
    const service = yield* ConversationSummaries.ConversationSummaries;
    const handoff = yield* prepareHandoff(MESSAGE_COUNT);
    const offered = yield* service.forHandoff({
      projectId,
      handoffs: [handoff],
      itemIds: new Set(Array.from({ length: MESSAGE_COUNT }, (_, index) => itemId(index))),
    });
    assert.deepEqual(
      offered.map((summary) => summary.id),
      [current.id],
    );
    assert.equal(model.calls.length, 0);
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect(
  "withholds a summary whose source changed, expands the rest canonically, and resummarizes",
  () => {
    const model = citing();
    return Effect.gen(function* () {
      yield* seed;
      yield* summarize;
      const summary = yield* onlySummary;
      const service = yield* ConversationSummaries.ConversationSummaries;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      yield* events.append({ events: [messageEvent(0, "Edited request")] });
      yield* projections.apply(messageEvent(0, "Edited request"));
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* maintenance.rebuild;

      const described = yield* service.describe({ ...scope, summaryId: summary.id });
      assert.deepEqual(described, {
        state: "stale",
        id: summary.id,
        sourceCount: 10,
        createdAt: summary.createdAt,
        reason: "changed",
      });
      const firstPage = yield* service.expand({ ...scope, summaryId: summary.id, limit: 2 });
      assert.equal(firstPage.summary.state, "stale");
      assert.deepEqual(firstPage.sources[0]!.result, { state: "unavailable", reason: "changed" });
      const second = firstPage.sources[1]!.result;
      assert.equal(second.state === "available" ? second.text : null, rawText(1));
      assert.equal(firstPage.nextOffset, 2);
      const lastPage = yield* service.expand({ ...scope, summaryId: summary.id, offset: 8 });
      assert.equal(lastPage.sources.length, 2);
      assert.equal(lastPage.nextOffset, null);
      const sql = yield* SqlClient.SqlClient;
      const stored = yield* sql<{
        payload: string;
      }>`SELECT payload_json AS payload FROM conversation_summaries WHERE summary_id = ${summary.id}`;
      assert.notInclude(stored[0]?.payload, summary.statements[0]!.text);
      assert.include(stored[0]?.payload, "Source unavailable");

      // The stale range no longer counts as covered, so the next pass summarizes it as it is now.
      yield* summarize;
      assert.equal(model.calls.length, 2);
      assert.equal(model.calls[1]!.messages[0]!.text, "Edited request");
      const states = (yield* list).summaries.map((read) => read.state).toSorted();
      assert.deepEqual(states, ["available"]);

      const replacement = yield* onlySummary;
      yield* projections.apply({
        id: EventId.make("thread-deleted"),
        type: "thread.deleted",
        threadId,
        providerInstanceId: instanceId,
        occurredAt: at,
        payload: { ...threadPayload, deletedAt: at },
      });
      const afterDelete = yield* service.expand({ ...scope, summaryId: replacement.id });
      assert.isTrue(
        afterDelete.sources.every(
          (source) => source.result.state === "unavailable" && source.result.reason === "deleted",
        ),
      );
      assert.isTrue((yield* list).summaries.every((read) => read.state === "stale"));
    }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
  },
);

it.effect(
  "cleans replaced and deleted summaries in bounded passes but preserves handoff references",
  () => {
    const model = citing();
    return Effect.gen(function* () {
      yield* seed;
      yield* summarize;
      const original = yield* onlySummary;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const handoffs = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* handoffs.prepareProviderHandoff({
        threadId,
        targetRunId: RunId.make("cleanup-target"),
        transferId: null,
        fromProviderThreadIds: [],
        toProviderThreadId: providerThread.id,
        fromProviderInstanceId: instanceId,
        toProviderInstanceId: instanceId,
        coveredRunOrdinals: { from: 1, to: 1 },
        strategy: "full_thread_summary",
        items: Array.from({ length: MESSAGE_COUNT }, (_, index) => item(index)),
        createdAt: at,
      });
      yield* projections.apply({
        id: EventId.make("referenced-summary"),
        type: "context-handoff.updated",
        threadId,
        providerInstanceId: instanceId,
        occurredAt: at,
        payload: {
          ...handoff,
          delivery: {
            nativeThreadId: "native-target",
            status: "inline",
            itemIds: [],
            omittedItemIds: [],
            summaryIds: [original.id],
            summarizedItemIds: [itemId(0)],
          },
        },
      });
      yield* projections.apply(messageEvent(0, "First edit"));
      yield* summarize;
      const second = (yield* list).summaries.find((read) => read.state === "available");
      if (second?.state !== "available") throw new Error("Expected replacement");
      yield* projections.apply(messageEvent(0, "Second edit"));
      // Stale but not yet replaced rows must survive.
      assert.equal((yield* list).summaries.length, 2);
      yield* summarize;
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly summary_id: string }>`
      SELECT summary_id FROM conversation_summaries
    `;
      assert.equal(rows.length, 2);
      assert.isTrue(rows.some((row) => row.summary_id === original.id));
      assert.isFalse(rows.some((row) => row.summary_id === second.summary.id));

      yield* projections.apply({
        id: EventId.make("cleanup-thread-deleted"),
        type: "thread.deleted",
        threadId,
        providerInstanceId: instanceId,
        occurredAt: at,
        payload: { ...threadPayload, deletedAt: at },
      });
      // More abandoned rows than one pass may delete, on a different thread from the pass.
      for (let index = 0; index < 101; index++) {
        yield* sql`
        INSERT INTO conversation_summaries
        SELECT ${"summary:" + index.toString(16).padStart(64, "0")}, project_id, thread_id,
          first_source_at, created_at, payload_json
        FROM conversation_summaries WHERE summary_id = ${original.id}
      `;
      }
      const service = yield* ConversationSummaries.ConversationSummaries;
      yield* service.summarizeThread({ threadId: ThreadId.make("missing-thread"), runId });
      const remaining = yield* sql<{ readonly count: number }>`
      SELECT count(*) AS count FROM conversation_summaries
    `;
      assert.equal(remaining[0]!.count, 3);
      yield* service.summarizeThread({ threadId: ThreadId.make("missing-thread"), runId });
      const retained = yield* sql<{ readonly summary_id: string }>`
      SELECT summary_id FROM conversation_summaries
    `;
      assert.deepEqual(
        retained.map((row) => row.summary_id),
        [original.id],
      );
    }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
  },
);

const providerThread: OrchestrationV2ProviderThread = {
  id: ProviderThreadId.make("provider-target"),
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: instanceId,
  providerSessionId: null,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: {
    driver: ProviderDriverKind.make("codex"),
    strength: "strong",
    nativeId: "native-target",
  },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
};

it.effect(
  "stops offering existing summaries after the project opts out and resumes on opt-in",
  () => {
    const model = citing();
    return Effect.gen(function* () {
      yield* seed;
      yield* summarize;
      const summary = yield* onlySummary;
      const service = yield* ConversationSummaries.ConversationSummaries;
      const settings = yield* ServerSettings.ServerSettingsService;
      const handoffs = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* handoffs.prepareProviderHandoff({
        threadId,
        targetRunId: RunId.make("opt-out-target-run"),
        transferId: null,
        fromProviderThreadIds: [],
        toProviderThreadId: providerThread.id,
        fromProviderInstanceId: instanceId,
        toProviderInstanceId: instanceId,
        coveredRunOrdinals: { from: 1, to: 1 },
        strategy: "full_thread_summary",
        items: Array.from({ length: MESSAGE_COUNT }, (_, index) => item(index)),
        createdAt: at,
      });
      const read = service.forHandoff({
        projectId,
        handoffs: [handoff],
        itemIds: new Set(Array.from({ length: MESSAGE_COUNT }, (_, index) => itemId(index))),
      });
      assert.deepEqual(
        (yield* read).map((offered) => offered.id),
        [summary.id],
      );
      yield* settings.updateSettings({
        projectSettingsOverrides: { [projectId]: { enableConversationSummaries: false } },
      });
      assert.deepEqual(yield* read, []);
      assert.equal((yield* list).summaries[0]?.state, "available");
      yield* settings.updateSettings(optedIn);
      assert.deepEqual(
        (yield* read).map((offered) => offered.id),
        [summary.id],
      );
      assert.equal(model.calls.length, 1);
    }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
  },
);

it.effect.each([0, 2])(
  "hands off a summary with source %i's knowledge and the intact tail within budget, once",
  (knowledgeSource) => {
    const model = citing();
    return Effect.gen(function* () {
      yield* seed;
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const fact = yield* knowledge.mutate(
        {
          action: "create",
          commandId: CommandId.make("summary-knowledge-create"),
          factId: ProjectFactId.make("summary-knowledge"),
          projectId,
          kind: "constraint",
          content: "Cache keys must include tenant IDs.",
          entities: [],
          tags: [],
          sources: [{ kind: "user" }],
        },
        { kind: "user" },
      );
      const context = {
        environmentId: EnvironmentId.make("summary-environment"),
        projectId,
        selections: [{ kind: "fact" as const, factId: fact.id, revision: fact.revision }],
        maxBytes: 48_000,
      };
      const prepared = yield* knowledge.resolveForTurn(context);
      yield* knowledge.recordDelivery({
        attemptId: RunAttemptId.make("summary-knowledge-attempt"),
        runId,
        threadId,
        messageId: messageId(knowledgeSource),
        projectId,
        providerInstanceId: instanceId,
        status: "sent",
        items: [
          {
            contextId: ComposerContextId.make("summary-knowledge-context"),
            label: "Cache isolation",
            context,
            text: prepared.text,
          },
        ],
        omissions: [],
        createdAt: DateTime.formatIso(at),
        updatedAt: DateTime.formatIso(at),
      });
      const edited = yield* knowledge.mutate(
        {
          action: "edit",
          commandId: CommandId.make("summary-knowledge-edit"),
          factId: fact.id,
          projectId,
          expectedRevision: fact.revision,
          content: "Cache keys must include region IDs.",
          kind: fact.kind,
          entities: fact.entities,
          tags: fact.tags,
          sources: fact.sources,
        },
        { kind: "user" },
      );
      yield* summarize;
      const summary = yield* onlySummary;
      const service = yield* ConversationSummaries.ConversationSummaries;
      let durable: OrchestrationV2ContextHandoff = yield* Effect.flatMap(
        ContextHandoffService.ContextHandoffServiceV2,
        (handoffs) =>
          handoffs.prepareProviderHandoff({
            threadId,
            targetRunId: RunId.make("target-run"),
            transferId: null,
            fromProviderThreadIds: [],
            toProviderThreadId: providerThread.id,
            fromProviderInstanceId: instanceId,
            toProviderInstanceId: instanceId,
            coveredRunOrdinals: { from: 1, to: 1 },
            strategy: "full_thread_summary",
            items: Array.from({ length: MESSAGE_COUNT }, (_, index) => item(index)),
            createdAt: at,
          }),
      );
      // The default cap cannot carry 16 long messages, so older history is omitted at prepare.
      assert.isAbove(durable.history!.omittedItems, 0);
      assert.equal(
        (durable.history!.omittedItemIds ?? []).includes(itemId(knowledgeSource)),
        knowledgeSource === 2,
      );
      const budget = 12_000;
      let summaryReads = 0;
      const itemIds = new Map(
        Array.from({ length: MESSAGE_COUNT }, (_, index) => [messageId(index), itemId(index)]),
      );
      const deliver = (handoff: OrchestrationV2ContextHandoff, nativeId = "native-target") =>
        deliverContextHandoffs({
          handoffs: [handoff],
          providerThread: {
            ...providerThread,
            nativeThreadRef: { ...providerThread.nativeThreadRef!, nativeId },
          },
          budget,
          alreadyDeliveredItemIds: new Set(),
          summaries: (itemIds) => {
            summaryReads += 1;
            return service.forHandoff({ projectId, handoffs: [handoff], itemIds });
          },
          evidence: (messages) =>
            deliveredKnowledgeForHistory({
              projectId,
              messages,
              userItemId: (id) => itemIds.get(id),
            }).pipe(Effect.provideService(ProjectKnowledge.ProjectKnowledge, knowledge)),
          persist: (next) =>
            Effect.sync(() => {
              durable = next;
            }),
        });

      const delivery = yield* deliver(durable);
      yield* delivery.delivered;
      assert.include(delivery.context, `[Conversation summary ${summary.id}`);
      assert.include(delivery.context, "It is a summary, not the original messages.");
      assert.include(delivery.context, "t3_conversation_summary_expand");
      assert.include(delivery.context, fact.content!);
      assert.equal(delivery.context.split("<t3_delivered_knowledge").length - 1, 1);
      assert.notInclude(delivery.context, edited.content!);
      assert.notInclude(delivery.context, rawText(0));
      for (let index = MESSAGE_COUNT - 2; index < MESSAGE_COUNT; index++)
        assert.include(delivery.context, rawText(index));
      assert.isAtMost(historyCost([], delivery.context), budget + 1_024);
      assert.deepEqual(durable.delivery?.summaryIds, [summary.id]);
      assert.deepEqual(
        durable.delivery?.summarizedItemIds?.toSorted(),
        Array.from({ length: 10 }, (_, index) => itemId(index)).toSorted(),
      );
      assert.isTrue(
        (durable.delivery?.omittedItemIds ?? []).every(
          (id) => !durable.delivery?.summarizedItemIds?.includes(id),
        ),
      );

      // The settled delivery is not delivered again, and no summary is read for it.
      const retry = yield* deliver(durable);
      assert.equal(retry.context, "");
      assert.equal(summaryReads, 1);

      yield* knowledge.mutate(
        {
          action: "forget",
          commandId: CommandId.make("summary-knowledge-forget"),
          factId: fact.id,
          projectId,
          expectedRevision: edited.revision,
        },
        { kind: "user" },
      );
      const afterForget = yield* deliver(durable, "replacement-native");
      assert.include(afterForget.context, `[Conversation summary ${summary.id}`);
      assert.notInclude(afterForget.context, fact.content!);
      assert.notInclude(afterForget.context, "t3_delivered_knowledge");
    }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
  },
);

const mcpScope = (capabilities: ReadonlySet<string>): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("summary-environment"),
  requestNamespace: "summary-session",
  thread: {
    threadId,
    providerSessionId: "summary-session",
    providerInstanceId: instanceId,
  },
  client: undefined,
  issuedAt: 0,
  capabilities: capabilities as McpInvocationContext.McpInvocationScope["capabilities"],
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "summary", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "summary", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("returns canonical source text through MCP expand only to callers that may read", () => {
  const model = citing();
  return Effect.gen(function* () {
    yield* seed;
    yield* summarize;
    const summary = yield* onlySummary;
    const service = yield* ConversationSummaries.ConversationSummaries;
    const serverLayer = McpHttpServer.toolkitRegistration(
      ConversationSummariesToolkit,
      SummaryHandlers.layer,
    ).pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed(id === threadId ? McpToolAccessTestkit.liveThreadShell(id) : null),
        }),
      ),
      Layer.provide(Layer.succeed(ConversationSummaries.ConversationSummaries, service)),
    );
    const call = (capabilities: ReadonlySet<string>) =>
      McpServer.McpServer.pipe(
        Effect.flatMap((server) =>
          server.callTool({
            name: "t3_conversation_summary_expand",
            arguments: { ...scope, summaryId: summary.id, limit: 1 },
          }),
        ),
        Effect.provideService(McpInvocationContext.McpInvocationContext, mcpScope(capabilities)),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
        Effect.provide(serverLayer),
      );
    const allowed = yield* call(new Set(["orchestration"]));
    const denied = yield* call(new Set());
    const text = (result: McpSchema.CallToolResult) => {
      const content = result.content[0];
      return content?.type === "text" ? JSON.parse(content.text) : undefined;
    };
    assert.notEqual(allowed.isError, true);
    assert.equal(text(allowed).sources[0].result.text, rawText(0));
    assert.isTrue(denied.isError);
    assert.equal(text(denied).code, "capability_denied");
    assert.notInclude(JSON.stringify(denied), "Detail.");
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});
