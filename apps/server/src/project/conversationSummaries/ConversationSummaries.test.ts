import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ComposerContextId,
  ConversationSummary,
  ConversationSummaryError,
  ConversationSummaryExpansion,
  ConversationSummaryId,
  ConversationSummaryList,
  ConversationSummaryPass,
  ConversationSummaryRead,
  ConversationSummarySearchInput,
  conversationSummarySourceKey,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  KnowledgeMessageRef,
  KnowledgeSourceUnavailableReason,
  MessageId,
  ModelSelection,
  NodeId,
  ProjectFactId,
  ProjectId,
  ProjectKnowledgeSource,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ServerSettings as ServerSettingsSchema,
  TextGenerationError,
  ThreadId,
  TurnItemId,
  WS_METHODS,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { historyCost } from "@t3tools/provider-core/server/handoffBudget";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { traceSqlRouting } from "../../persistence/testkit/SqliteRouting.ts";
import { conversationSummariesRpcHandlers } from "../../conversationSummariesRpc.ts";
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
import * as ProjectionReplay from "../../orchestration-v2/testkit/ProjectionReplay.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as HolographicMemory from "../knowledge/HolographicMemory.ts";
import * as ProjectKnowledge from "../knowledge/ProjectKnowledge.ts";
import { deliveredKnowledgeForHistory } from "../knowledge/composer.ts";
import * as ConversationSummaries from "./ConversationSummaries.ts";
import Migration0094 from "../../persistence/Migrations/094_ConversationSummaryPosition.ts";
import Migration0096 from "../../persistence/Migrations/096_ProjectKnowledgeViews.ts";
import { leafPosition } from "./conversationSummaryTree.ts";
import {
  ConversationSummaryPassError,
  conversationSummaryEffects,
} from "./conversationSummarySchedule.ts";

type Generate = TextGeneration.TextGeneration["Service"]["generateConversationSummary"];

const projectId = ProjectId.make("00000000-0000-4000-8000-000000000001");
const threadId = ThreadId.make("summary-thread");
const instanceId = ProviderInstanceId.make("codex");
const runId = RunId.make("summary-run");
const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 22));
const scope = { projectId, threadId };
const optedIn = {
  projectSettingsOverrides: { [projectId]: { enableConversationSummaries: true } },
};
const decodeSettings = Schema.decodeUnknownEffect(ServerSettingsSchema);
const decodeSummarySearchInput = Schema.decodeEffect(ConversationSummarySearchInput);
const encodeSummary = Schema.encodeEffect(Schema.fromJsonString(ConversationSummary));
// Freeze the protocol-2 summary codec from before ranged/tool sources. An older client
// compiles these shapes into RpcClient; merely accepting our current schema proves nothing.
const LegacySummary = Schema.Struct({
  id: ConversationSummaryId,
  projectId: ProjectId,
  threadId: ThreadId,
  sources: Schema.Array(KnowledgeMessageRef).check(Schema.isMinLength(1), Schema.isMaxLength(24)),
  statements: Schema.Array(
    Schema.Struct({
      text: Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(600)),
      citations: Schema.Array(MessageId).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  modelSelection: ModelSelection,
  createdAt: Schema.String,
});
const LegacySummaryRead = Schema.Union([
  Schema.Struct({ state: Schema.Literal("available"), summary: LegacySummary }),
  Schema.Struct({
    state: Schema.Literal("stale"),
    id: ConversationSummaryId,
    sourceCount: Schema.Int,
    createdAt: Schema.String,
    reason: KnowledgeSourceUnavailableReason,
  }),
]);
const LegacySummaryList = Schema.Struct({
  enabled: Schema.Boolean,
  lastPass: Schema.NullOr(ConversationSummaryPass),
  summaries: Schema.Array(LegacySummaryRead),
  nextCursor: Schema.NullOr(ConversationSummaryId),
});
const LegacySummaryExpansion = Schema.Struct({
  summary: LegacySummaryRead,
  sources: Schema.Array(
    Schema.Struct({ ref: KnowledgeMessageRef, result: ProjectKnowledgeSource }),
  ),
  nextOffset: Schema.NullOr(Schema.Int),
});
const LegacySummaryError = Schema.TaggedStruct("ConversationSummaryError", {
  reason: Schema.Literals(["storage", "missing_project", "missing_summary", "invalid_cursor"]),
  projectId: ProjectId,
  cause: Schema.optionalKey(Schema.Defect()),
});
const encodeSummaryReadWire = Schema.encodeSync(Schema.toCodecJson(ConversationSummaryRead));
const encodeSummaryListWire = Schema.encodeSync(Schema.toCodecJson(ConversationSummaryList));
const encodeSummaryExpansionWire = Schema.encodeSync(
  Schema.toCodecJson(ConversationSummaryExpansion),
);
const decodeLegacyRead = Schema.decodeUnknownSync(Schema.toCodecJson(LegacySummaryRead));
const decodeLegacyList = Schema.decodeUnknownSync(Schema.toCodecJson(LegacySummaryList));
const decodeLegacyExpansion = Schema.decodeUnknownSync(Schema.toCodecJson(LegacySummaryExpansion));
const encodeSummaryErrorWire = Schema.encodeSync(Schema.toCodecJson(ConversationSummaryError));
const decodeLegacyError = Schema.decodeUnknownSync(Schema.toCodecJson(LegacySummaryError));
const assertLegacyUpgradeError = (error: ConversationSummaryError) => {
  const decoded = decodeLegacyError(encodeSummaryErrorWire(error));
  assert.equal(decoded.reason, "storage");
  assert.include(String(decoded.cause), "Update this T3 Code client");
};
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

// Replies as long as the statement contract allows, so byte budgets meet their worst case.
const verbose = () =>
  scripted((input) =>
    Effect.succeed({
      statements: Array.from({ length: 8 }, (_, index) => ({
        text: `Statement ${index} about ${input.messages.length} sources. ${"Said and done. ".repeat(38)}`,
        citations: [input.messages[index % input.messages.length]!.ref],
      })),
    }),
  );
const isRollup = (call: Parameters<Generate>[0]) =>
  call.messages.some((message) => message.role === "summary");

// An update returns once the service has pulled the next change, so its reaction has finished.
// With no subscriber pulling, an update waits forever.
const settingsLayer = (overrides: Parameters<typeof ServerSettings.layerTest>[0]) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const base = yield* ServerSettings.ServerSettingsService;
      const changes = yield* Queue.unbounded<{
        readonly settings: ServerSettingsSchema;
        readonly handled: Deferred.Deferred<void>;
      }>();
      let handling: Deferred.Deferred<void> | undefined;
      const stream = Stream.fromEffectRepeat(
        Effect.gen(function* () {
          if (handling !== undefined) yield* Deferred.succeed(handling, undefined);
          const next = yield* Queue.take(changes);
          handling = next.handled;
          return next.settings;
        }),
      );
      return {
        ...base,
        updateSettings: (patch) =>
          base.updateSettings(patch).pipe(
            Effect.tap((settings) =>
              Effect.gen(function* () {
                const handled = yield* Deferred.make<void>();
                yield* Queue.offer(changes, { settings, handled });
                yield* Deferred.await(handled);
              }),
            ),
          ),
        streamChanges: stream,
        subscribeChanges: Effect.succeed(stream),
      } satisfies ServerSettings.ServerSettingsService["Service"];
    }),
  ).pipe(Layer.provide(ServerSettings.layerTest(overrides)));

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
        ProjectionReplay.layer.pipe(
          Layer.provideMerge(EventStore.layer),
          Layer.provide(ProjectionStore.layer),
        ),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(settingsLayer(settings)),
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

const item = (
  index: number,
): Extract<OrchestrationV2TurnItem, { type: "user_message" | "assistant_message" }> => {
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
      summary_id, project_id, thread_id, position, created_at, payload_json
    ) VALUES (
      ${summary.id}, ${projectId}, ${threadId},
      ${leafPosition(DateTime.formatIso(DateTime.add(at, { minutes: sourceIndexes[0]! })), sources[0]!)},
      ${summary.createdAt}, ${payloadJson}
    )
  `;
  return summary;
});

const prepareHandoff = Effect.fn("test.prepareSummaryHandoff")(function* (
  messageCount: number,
  extraItems: ReadonlyArray<OrchestrationV2TurnItem> = [],
) {
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
    items: [...extraItems, ...Array.from({ length: messageCount }, (_, index) => item(index))],
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
        summary.sources.map((source) => (source.kind === "message" ? source.messageId : null)),
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

it.effect(
  "invalidates legacy peer attribution and changed speaker metadata through rollups",
  () => {
    const model = citing();
    return Effect.gen(function* () {
      yield* seed;
      const legacy = yield* persistSummary(
        900,
        Array.from({ length: 10 }, (_, index) => index),
      );
      const service = yield* ConversationSummaries.ConversationSummaries;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const peer = item(1);
      if (peer.type !== "assistant_message") return yield* Effect.die("Expected a peer reply");
      yield* projections.apply({
        id: EventId.make("peer-reply-attribution"),
        type: "turn-item.updated",
        threadId,
        providerInstanceId: instanceId,
        occurredAt: at,
        payload: { ...peer, speaker: { label: "Astra", model: "gpt-6-astra" } },
      });
      assert.equal((yield* service.describe({ ...scope, summaryId: legacy.id })).state, "stale");
      yield* summarize;
      const regenerated = yield* onlySummary;
      assert.notEqual(regenerated.id, legacy.id);
      assert.deepEqual(model.calls[0]?.messages[1], {
        ref: "M2",
        role: "peer",
        speaker: { label: "Astra", model: "gpt-6-astra" },
        text: rawText(1),
      });
      assert.deepEqual(model.calls[0]?.messages[3], {
        ref: "M4",
        role: "assistant",
        text: rawText(3),
      });
      const sql = yield* SqlClient.SqlClient;
      const parent = {
        ...regenerated,
        id: `summary:${"e".repeat(64)}`,
        sources: [{ kind: "summary" as const, threadId, summaryId: regenerated.id }],
        statements: [{ text: "The peer proposed the fix.", citations: [regenerated.id] }],
      };
      yield* sql`INSERT INTO conversation_summaries
      (summary_id, project_id, thread_id, position, created_at, payload_json)
      SELECT ${parent.id}, project_id, thread_id, position || ':parent', created_at, ${yield* encodeSummary(parent)}
      FROM conversation_summaries WHERE summary_id = ${regenerated.id}`;
      assert.equal(
        (yield* service.describe({ ...scope, summaryId: parent.id })).state,
        "available",
      );
      yield* projections.apply({
        id: EventId.make("peer-identity-corrected"),
        type: "turn-item.updated",
        threadId,
        providerInstanceId: instanceId,
        occurredAt: at,
        payload: { ...peer, speaker: { label: "Fable", model: "gpt-6-luna" } },
      });
      assert.equal((yield* service.describe({ ...scope, summaryId: parent.id })).state, "stale");
      assert.equal(
        (yield* service.describe({ ...scope, summaryId: regenerated.id })).state,
        "stale",
      );
      yield* summarize;
      const corrected = yield* onlySummary;
      assert.notEqual(corrected.id, regenerated.id);
      assert.deepEqual(model.calls.at(-1)?.messages[1], {
        ref: "M2",
        role: "peer",
        speaker: { label: "Fable", model: "gpt-6-luna" },
        text: rawText(1),
      });
    }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
  },
);

it.effect("negotiates ranged summary responses while preserving legacy whole-message reads", () => {
  const model = citing();
  return Effect.gen(function* () {
    // Sixteen settled sources exceed the new default text budget but fit one legacy page.
    yield* seedThread(22);
    yield* summarize;
    const service = yield* ConversationSummaries.ConversationSummaries;
    const rpc = conversationSummariesRpcHandlers(service);
    const ordinary = yield* onlySummary;
    const oldList = decodeLegacyList(
      encodeSummaryListWire(yield* rpc[WS_METHODS.conversationSummariesList](scope)),
    );
    assert.equal(oldList.summaries.length, 1);
    const oldRead = decodeLegacyRead(
      encodeSummaryReadWire(
        yield* rpc[WS_METHODS.conversationSummariesDescribe]({ ...scope, summaryId: ordinary.id }),
      ),
    );
    assert.equal(oldRead.state, "available");
    const oldPage = decodeLegacyExpansion(
      encodeSummaryExpansionWire(
        yield* rpc[WS_METHODS.conversationSummariesExpand]({ ...scope, summaryId: ordinary.id }),
      ),
    );
    assert.equal(oldPage.sources.length, 16);
    assert.isNull(oldPage.nextOffset);
    const modernDecode = Schema.decodeUnknownEffect(
      Schema.toCodecJson(ConversationSummaryExpansion),
    );
    const legacyEncode = Schema.encodeEffect(Schema.toCodecJson(LegacySummaryExpansion));
    const fromOldServer = yield* modernDecode(yield* legacyEncode(oldPage));
    assert.deepEqual(fromOldServer, oldPage);
    assert.equal(fromOldServer.nextTextOffset ?? 0, 0);
    assert.equal(
      oldPage.sources[0]?.result.state === "available" ? oldPage.sources[0].result.text : null,
      rawText(0),
    );
    assertLegacyUpgradeError(
      yield* rpc[WS_METHODS.conversationSummariesExpand]({
        ...scope,
        summaryId: ordinary.id,
        maxChars: 2,
      }).pipe(Effect.flip),
    );

    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* projections.apply(messageEvent(0, `${"Long source. ".repeat(900)}END`));
    yield* summarize;
    const ranged = yield* onlySummary;
    const describe = { ...scope, summaryId: ranged.id };
    // The old codec accepts a ranged message after stripping its range, but cannot resolve
    // the new citation key. The transport must prevent this silent misrepresentation too.
    const unsafe = decodeLegacyRead(encodeSummaryReadWire(yield* service.describe(describe)));
    if (unsafe.state !== "available") return yield* Effect.die("Expected current ranged evidence");
    const oldIds = new Set<string>(unsafe.summary.sources.map((source) => source.messageId));
    assert.isTrue(
      unsafe.summary.statements.some((statement) =>
        statement.citations.some((citation) => !oldIds.has(citation)),
      ),
    );
    assertLegacyUpgradeError(
      yield* rpc[WS_METHODS.conversationSummariesList](scope).pipe(Effect.flip),
    );
    assertLegacyUpgradeError(
      yield* rpc[WS_METHODS.conversationSummariesDescribe](describe).pipe(Effect.flip),
    );
    assertLegacyUpgradeError(
      yield* rpc[WS_METHODS.conversationSummariesExpand](describe).pipe(Effect.flip),
    );
    const modern = yield* rpc[WS_METHODS.conversationSummariesExpand]({
      ...describe,
      sourceFormat: 2,
      maxChars: 257,
    });
    assert.equal(modern.summary.state, "available");
    assert.equal(modern.nextOffset, 0);
    assert.equal(modern.nextTextOffset, 257);
    assert.isTrue(
      modern.sources.some(({ ref }) => ref.kind !== "summary" && ref.range !== undefined),
    );
    assert.equal(
      (yield* rpc[WS_METHODS.conversationSummariesList]({ ...scope, sourceFormat: 2 })).summaries
        .length,
      1,
    );
    assert.equal(
      (yield* rpc[WS_METHODS.conversationSummariesDescribe]({ ...describe, sourceFormat: 2 }))
        .state,
      "available",
    );
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect.each([60_000, 48_000])(
  "rejects an incomplete legacy expansion page for a %s-character source",
  (chars) => {
    const model = citing();
    return Effect.gen(function* () {
      yield* seed;
      const legacy = yield* persistSummary(40, [0, 1]);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const text = "x".repeat(chars);
      yield* projections.apply(messageEvent(0, text));
      const crypto = yield* Digest.Digest;
      const digest = Hex.encode(
        yield* crypto.digest(Digest.sha256, new TextEncoder().encode(text)),
      );
      const payload = {
        ...legacy,
        sources: legacy.sources.map((source, index) =>
          index === 0 ? { ...source, digest } : source,
        ),
      };
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE conversation_summaries SET payload_json = ${yield* encodeSummary(payload)} WHERE summary_id = ${legacy.id}`;
      const service = yield* ConversationSummaries.ConversationSummaries;
      const rpc = conversationSummariesRpcHandlers(service);
      const input = { ...scope, summaryId: legacy.id, limit: 2 };
      const modern = yield* rpc[WS_METHODS.conversationSummariesExpand]({
        ...input,
        sourceFormat: 2,
        maxChars: 48_000,
      });
      // At 60K the cursor stays inside the source; at 48K it stops exactly before source 2.
      // Both decode on an old client, but neither fulfills its requested two-source page.
      const unsafe = decodeLegacyExpansion(encodeSummaryExpansionWire(modern));
      assert.equal(unsafe.sources.length, 1);
      assert.equal(modern.nextOffset, chars === 60_000 ? 0 : 1);
      assert.equal(modern.nextTextOffset, chars === 60_000 ? 48_000 : 0);
      assertLegacyUpgradeError(
        yield* rpc[WS_METHODS.conversationSummariesExpand](input).pipe(Effect.flip),
      );
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

it.effect("reports a summary pass as pending until it settles", () =>
  Effect.gen(function* () {
    const service = yield* ConversationSummaries.ConversationSummaries;
    const sql = yield* SqlClient.SqlClient;
    const pending = service.hasPendingPass({ threadId });
    const now = DateTime.formatIso(at);
    const [effect] = conversationSummaryEffects({
      settings: yield* decodeSettings(optedIn),
      projectId,
      threadId,
      runId,
    });
    assert.isFalse(yield* pending);
    yield* sql`
      INSERT INTO orchestration_v2_effect_outbox (
        effect_id, command_id, thread_id, effect_type, payload_json, status, available_at,
        created_at, updated_at
      ) VALUES (${effect!.id}, ${effect!.commandId}, ${threadId}, ${effect!.request.type},
        ${JSON.stringify(effect!.request)}, 'running', ${now}, ${now}, ${now})`;
    assert.isTrue(yield* pending);
    yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded'`;
    assert.isFalse(yield* pending);
  }).pipe(Effect.provide(makeLayer(citing().generate, optedIn))),
);

it.effect.each([
  { work: "leaf", waitingMessages: 10 },
  { work: "rollup", waitingMessages: 0 },
])(
  "recovers failed and legacy $work passes with bounded model-specific retry rounds",
  ({ work, waitingMessages }) => {
    let gate: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined;
    const model = scripted(() =>
      Effect.gen(function* () {
        if (gate !== undefined) {
          yield* Deferred.succeed(gate.entered, undefined);
          yield* Deferred.await(gate.release);
        }
        return yield* new TextGenerationError({
          operation: "generateConversationSummary",
          detail: "No model",
        });
      }),
    );
    return Effect.gen(function* () {
      yield* seedThread(work === "rollup" ? 14 : MESSAGE_COUNT);
      if (work === "rollup") {
        for (let index = 0; index < 4; index++)
          yield* persistSummary(index, [index * 2, index * 2 + 1]);
      }
      assert.instanceOf(yield* summarize.pipe(Effect.flip), ConversationSummaryPassError);
      const result = yield* list;
      assert.lengthOf(result.summaries, work === "rollup" ? 4 : 0);
      assert.deepInclude(result.lastPass, {
        result: "failed",
        reason: "No model",
        waitingMessages,
      });
      const service = yield* ConversationSummaries.ConversationSummaries;
      const sql = yield* SqlClient.SqlClient;
      const stored = yield* sql<{ readonly modelKey: string }>`
      SELECT json_extract(payload_json, '$.modelKey') AS "modelKey"
      FROM conversation_summary_passes WHERE thread_id = ${threadId}
    `;
      const modelKey = stored[0]?.modelKey ?? "";
      assert.include(modelKey, "codex");
      const stalled = (key = modelKey) => service.stalledThreads({ modelKey: key, limit: 2 });
      assert.deepEqual(yield* stalled(), []);
      yield* TestClock.adjust("15 minutes");
      assert.deepInclude((yield* stalled())[0], { threadId, runId, retry: 1 });
      assert.deepEqual(yield* stalled(`${modelKey}:other`), []);
      yield* sql`
      UPDATE conversation_summary_passes
      SET payload_json = json_remove(payload_json, '$.modelKey') WHERE thread_id = ${threadId}
    `;
      assert.deepInclude((yield* stalled())[0], { threadId, runId, retry: 1 });
      assert.deepEqual(yield* stalled(`${modelKey}:other`), []);
      for (let attempt = 0; attempt < 5; attempt++) {
        yield* service.summarizeThread({ threadId, runId, retry: 1 }).pipe(Effect.flip);
      }
      yield* TestClock.adjust("15 minutes");
      assert.deepEqual(yield* stalled(), []);
      yield* TestClock.adjust("15 minutes");
      const nextRetry = (yield* stalled())[0];
      assert.deepInclude(nextRetry, { threadId, runId, retry: 2 });
      yield* sql`
      UPDATE conversation_summary_passes
      SET payload_json = json_set(payload_json, '$.retries', 6) WHERE thread_id = ${threadId}
    `;
      yield* TestClock.adjust("2 days");
      assert.deepEqual(yield* stalled(), []);
      yield* sql`
      UPDATE conversation_summary_passes
      SET payload_json = json_set(payload_json, '$.retries', 5) WHERE thread_id = ${threadId}
    `;
      const finalRetry = (yield* stalled())[0]!;
      assert.deepInclude(finalRetry, { threadId, runId, retry: 6 });
      gate = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
      const pass = yield* service.summarizeThread(finalRetry).pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(gate.entered);
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        projectSettingsOverrides: { [projectId]: { enableConversationSummaries: false } },
      });
      yield* settings.updateSettings(optedIn);
      yield* Deferred.succeed(gate.release, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(pass)));
      gate = undefined;
      yield* TestClock.adjust("15 minutes");
      assert.deepInclude((yield* stalled())[0], { threadId, runId, retry: 1 });
      yield* sql`
      UPDATE conversation_summary_passes
      SET payload_json = json_set(payload_json, '$.retries', 6) WHERE thread_id = ${threadId}
    `;
      const freshRunId = RunId.make("summary-fresh-run");
      yield* service.summarizeThread({ threadId, runId: freshRunId }).pipe(Effect.flip);
      yield* TestClock.adjust("15 minutes");
      assert.deepInclude((yield* stalled())[0], { threadId, runId: freshRunId, retry: 1 });
      yield* sql`UPDATE projection_projects SET deleted_at = '2026-01-01T00:00:00.000Z'
      WHERE project_id = ${projectId}`;
      assert.deepEqual(yield* stalled(), []);
    }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
  },
);

const failingStretch = (kind: "empty" | "invalid-output" | "unlabelled") =>
  kind === "unlabelled"
    ? new TextGenerationError({
        operation: "generateConversationSummary",
        detail: "Router rejected the request: the prompt is too long.",
      })
    : new TextGenerationError({
        operation: "generateConversationSummary",
        detail:
          kind === "empty"
            ? "Router returned no text."
            : "Router returned a reply T3 Code couldn't read.",
        kind,
      });

// An unlabelled failure fails the pass before any success, so it takes two more passes to skip.
it.effect.each([
  { kind: "empty", results: ["ran", "ran"] },
  { kind: "invalid-output", results: ["ran", "ran"] },
  { kind: "unlabelled", results: ["failed", "ran", "failed", "ran"] },
] as const)(
  "skips a stretch whose summary is always $kind while other stretches summarize, and rolls up past it",
  ({ kind, results }) => {
    const model = scripted((input) =>
      input.messages[0]?.text === rawText(0)
        ? Effect.fail(failingStretch(kind))
        : Effect.succeed({
            statements: [{ text: "A later stretch.", citations: [input.messages[0]!.ref] }],
          }),
    );
    const firstStretchCalls = () =>
      model.calls.filter((call) => call.messages[0]?.text === rawText(0)).length;
    return Effect.gen(function* () {
      // Five full leaves of 24 settled messages.
      yield* seedThread(5 * 24 + 6);
      const passes: Array<string | undefined> = [];
      for (let pass = 0; pass < results.length; pass++) {
        yield* Effect.exit(summarize);
        passes.push((yield* list).lastPass?.result);
      }
      assert.deepEqual(passes, [...results]);
      assert.equal(firstStretchCalls(), results.length);
      const skipped = (yield* list).lastPass;
      assert.include(skipped?.reason ?? "", "Skipped a stretch");
      assert.equal(skipped?.waitingMessages, 0);
      assert.notProperty(skipped, "chunkFailures");

      yield* summarize;
      assert.equal(firstStretchCalls(), results.length);
      assert.isTrue(isRollup(model.calls.at(-1)!));
      const service = yield* ConversationSummaries.ConversationSummaries;
      const offered = yield* service.forHandoff({
        projectId,
        handoffs: [yield* prepareHandoff(5 * 24 + 6)],
        itemIds: new Set(Array.from({ length: 5 * 24 }, (_, index) => itemId(index))),
      });
      const offeredIds = offered.flatMap((offer) => offer.coveredItemIds);
      assert.notInclude(offeredIds, itemId(0));
      assert.include(offeredIds, itemId(24));

      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        projectSettingsOverrides: { [projectId]: { enableConversationSummaries: false } },
      });
      yield* summarize;
      yield* settings.updateSettings(optedIn);
      yield* Effect.exit(summarize);
      assert.equal(firstStretchCalls(), results.length + 1);

      yield* settings.updateSettings({
        textGenerationModelSelection: { instanceId, model: "gpt-5-mini" },
      });
      yield* Effect.exit(summarize);
      assert.equal(firstStretchCalls(), results.length + 2);
    }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
  },
);

it.effect.each([
  { recovered: messageId(0), stuck: undefined },
  { recovered: messageId(24), stuck: rawText(0) },
])(
  "skips nothing while every summary comes back empty, then summarizes $recovered",
  ({ recovered, stuck }) => {
    let down = true;
    const model = scripted((input) =>
      down || input.messages[0]?.text === stuck
        ? Effect.fail(failingStretch("empty"))
        : Effect.succeed({
            statements: [{ text: "Recovered.", citations: [input.messages[0]!.ref] }],
          }),
    );
    return Effect.gen(function* () {
      yield* seedThread(5 * 24 + 6);
      const callsPerPass: Array<number> = [];
      for (let pass = 0; pass < 3; pass++) {
        const before = model.calls.length;
        assert.isFalse((yield* summarize).hasMore);
        callsPerPass.push(model.calls.length - before);
      }
      // Once every stretch is a suspect, one call per pass tests the model.
      assert.deepEqual(callsPerPass, [3, 3, 1]);
      assert.deepEqual((yield* list).summaries, []);

      down = false;
      yield* summarize;
      assert.include(
        (yield* list).summaries.flatMap((read) =>
          read.state === "available"
            ? read.summary.sources.flatMap((source) =>
                source.kind === "message" ? [source.messageId] : [],
              )
            : [],
        ),
        recovered,
      );
    }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
  },
);

it.effect("counts only a stretch's own failures beside a success after an outage", () => {
  let down = true;
  let flaky = rawText(0);
  const model = scripted((input) =>
    down || input.messages[0]?.text === flaky
      ? Effect.fail(failingStretch("empty"))
      : Effect.succeed({
          statements: [{ text: "Summarized.", citations: [input.messages[0]!.ref] }],
        }),
  );
  return Effect.gen(function* () {
    yield* seedThread(5 * 24 + 6);
    yield* summarize;

    down = false;
    yield* summarize;
    assert.notInclude((yield* list).lastPass?.reason ?? "", "Skipped");

    flaky = rawText(48);
    yield* summarize;
    assert.notInclude((yield* list).lastPass?.reason ?? "", "Skipped");

    flaky = "";
    for (let pass = 0; pass < 2; pass++) yield* summarize;
    assert.equal((yield* list).lastPass?.waitingMessages, 0);
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect("moves past three bad leaf stretches at the front and skips them", () => {
  const bad = new Set([rawText(0), rawText(24), rawText(48)]);
  const model = scripted((input) =>
    bad.has(input.messages[0]!.text)
      ? Effect.fail(failingStretch("invalid-output"))
      : Effect.succeed({
          statements: [{ text: "A later stretch.", citations: [input.messages[0]!.ref] }],
        }),
  );
  const badCalls = () => model.calls.filter((call) => bad.has(call.messages[0]?.text ?? "")).length;
  return Effect.gen(function* () {
    yield* seedThread(8 * 24 + 6);
    yield* summarize;
    yield* summarize;
    assert.isNotEmpty((yield* list).summaries);

    for (let pass = 0; pass < 3; pass++) yield* summarize;
    assert.include((yield* list).lastPass?.reason ?? "", "Skipped 3 stretches");
    const settled = badCalls();
    yield* summarize;
    assert.equal(badCalls(), settled);
    assert.isTrue(model.calls.some(isRollup));
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect("moves past roll-ups that all contain one bad summary", () => {
  const model = scripted((input) =>
    isRollup(input) && input.messages.some((message) => message.text === "- Summary 2")
      ? Effect.fail(failingStretch("invalid-output"))
      : Effect.succeed({
          statements: [{ text: "Summarized.", citations: [input.messages[0]!.ref] }],
        }),
  );
  const badCalls = () =>
    model.calls.filter((call) => call.messages.some((message) => message.text === "- Summary 2"))
      .length;
  return Effect.gen(function* () {
    yield* seedThread(6 * 2 + 6 * 24 + 6);
    for (let index = 0; index < 6; index++)
      yield* persistSummary(index, [index * 2, index * 2 + 1]);
    yield* summarize;
    assert.equal(badCalls(), 3);
    yield* summarize;
    const sources = (yield* list).summaries.flatMap((read) =>
      read.state === "available" ? read.summary.sources : [],
    );
    assert.isTrue(
      sources.some((source) => source.kind === "message" && source.messageId === messageId(12)),
    );

    for (let pass = 0; pass < 3; pass++) yield* summarize;
    assert.equal((yield* list).lastPass?.waitingMessages, 0);
    const settled = badCalls();
    yield* summarize;
    assert.equal(badCalls(), settled);
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect.each([
  { counted: "skipped", stretches: 70, passesBefore: 2, calls: 2 },
  { counted: "failed once", stretches: 80, passesBefore: 1, calls: 3 },
])(
  "keeps a stretch $counted when an outage fills the failure ledger",
  ({ stretches, passesBefore, calls }) => {
    let down = false;
    const model = scripted((input) =>
      down || input.messages[0]?.text === rawText(1)
        ? Effect.fail(failingStretch("empty"))
        : Effect.succeed({
            statements: [{ text: "Summarized.", citations: [input.messages[0]!.ref] }],
          }),
    );
    const skippedCalls = () =>
      model.calls.filter((call) => call.messages[0]?.text === rawText(1)).length;
    return Effect.gen(function* () {
      // Leaves over the even messages leave each odd message a stretch of its own.
      yield* seedThread(stretches * 2 + 6);
      for (let index = 0; index < stretches; index++) yield* persistSummary(index, [index * 2]);
      for (let pass = 0; pass < passesBefore; pass++) yield* summarize;

      down = true;
      for (let pass = 0; pass < 25; pass++) yield* summarize;
      down = false;
      for (let pass = 0; pass < 10; pass++) yield* summarize;
      assert.equal(skippedCalls(), calls);
    }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
  },
);

it.effect("skips a stretch that fails twice when the ledger is full of skipped stretches", () => {
  let down = true;
  const lateStretch = rawText(66 * 2 + 1);
  const model = scripted((input) =>
    down || input.messages[0]?.text === lateStretch
      ? Effect.fail(failingStretch("empty"))
      : Effect.succeed({
          statements: [{ text: "Summarized.", citations: [input.messages[0]!.ref] }],
        }),
  );
  const lateCalls = () =>
    model.calls.filter((call) => call.messages[0]?.text === lateStretch).length;
  return Effect.gen(function* () {
    // Leaves over the even messages leave each odd message a stretch of its own.
    const stretches = 71;
    yield* seedThread(stretches * 2 + 6);
    for (let index = 0; index < stretches; index++) yield* persistSummary(index, [index * 2]);
    // An outage records the first 66 stretches, three a pass. Marking them skipped stands in
    // for the hundreds of passes it takes to skip that many.
    for (let pass = 0; pass < 22; pass++) yield* summarize;
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM conversation_summary_passes WHERE thread_id = ${threadId}
    `;
    const stored: { chunkFailures: ReadonlyArray<{ readonly key: string }> } = JSON.parse(
      row!.payload_json,
    );
    assert.lengthOf(stored.chunkFailures, 64);
    const skipped = stored.chunkFailures.map(({ key }) => ({
      key,
      failures: 2,
      skipped: true,
      reason: "Router returned no text.",
    }));
    yield* sql`
      UPDATE conversation_summary_passes
      SET payload_json = ${JSON.stringify({ ...stored, chunkFailures: skipped })}
      WHERE thread_id = ${threadId}
    `;

    down = false;
    for (let pass = 0; pass < 30; pass++) yield* summarize;
    assert.equal(lateCalls(), 2);
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect("summarizes the next stretch when the model cites none of the chunk", () => {
  const model = scripted((input) =>
    Effect.succeed({
      statements: [
        {
          text: input.messages[0]?.text === rawText(0) ? "Uncited." : "The later stretch.",
          citations: input.messages[0]?.text === rawText(0) ? ["M999"] : [input.messages[0]!.ref],
        },
      ],
    }),
  );
  return Effect.gen(function* () {
    yield* seedThread(38);
    yield* summarize;
    assert.equal(model.calls.filter((call) => call.messages[0]?.text === rawText(24)).length, 1);
    assert.notInclude(
      (yield* list).summaries.flatMap((read) =>
        read.state === "available"
          ? read.summary.sources.flatMap((source) =>
              source.kind === "message" ? [source.messageId] : [],
            )
          : [],
      ),
      messageId(0),
    );
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect.each([0, 1])(
  "skips nothing while every summary after the first %i of a pass times out",
  (healthy) => {
    let down = true;
    let callsThisPass = 0;
    const model = scripted((input) =>
      down && callsThisPass++ >= healthy
        ? Effect.fail(
            new TextGenerationError({
              operation: "generateConversationSummary",
              detail: "OpenCode did not finish generating in time.",
            }),
          )
        : Effect.succeed({
            statements: [{ text: "Recovered.", citations: [input.messages[0]!.ref] }],
          }),
    );
    return Effect.gen(function* () {
      yield* seedThread(5 * 24 + 6);
      for (let pass = 0; pass < 4; pass++) {
        callsThisPass = 0;
        const exit = yield* Effect.exit(summarize);
        if (healthy === 0) assert.isTrue(Exit.isFailure(exit));
        assert.notInclude((yield* list).lastPass?.reason ?? "", "Skipped");
      }
      if (healthy === 0) assert.deepEqual((yield* list).summaries, []);

      down = false;
      for (let pass = 0; pass < 3; pass++) yield* summarize;
      assert.equal((yield* list).lastPass?.waitingMessages, 0);
      assert.notInclude((yield* list).lastPass?.reason ?? "", "Skipped");
    }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
  },
);

it.effect("turning summaries back on during a pass still retries skipped stretches", () => {
  let gate: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined;
  const model = scripted((input) =>
    Effect.gen(function* () {
      if (gate !== undefined) {
        yield* Deferred.succeed(gate.entered, undefined);
        yield* Deferred.await(gate.release);
      }
      if (input.messages[0]?.text === rawText(0)) return yield* failingStretch("empty");
      return { statements: [{ text: "Summarized.", citations: [input.messages[0]!.ref] }] };
    }),
  );
  const firstStretchCalls = () =>
    model.calls.filter((call) => call.messages[0]?.text === rawText(0)).length;
  return Effect.gen(function* () {
    yield* seedThread(5 * 24 + 6);
    yield* summarize;
    yield* summarize;
    assert.include((yield* list).lastPass?.reason ?? "", "Skipped a stretch");

    gate = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
    const pass = yield* summarize.pipe(Effect.forkChild);
    yield* Deferred.await(gate.entered);
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({
      projectSettingsOverrides: { [projectId]: { enableConversationSummaries: false } },
    });
    yield* settings.updateSettings(optedIn);
    yield* Deferred.succeed(gate.release, undefined);
    yield* Fiber.join(pass);
    gate = undefined;

    yield* summarize;
    assert.equal(firstStretchCalls(), 3);
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect(
  "covers every range of a long source and offers it only after all ranges are summarized",
  () => {
    const model = citing();
    return Effect.gen(function* () {
      yield* seed;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const longText = `${"aaaaaa🧪".repeat(17_000)}TAIL-EXACT-EVIDENCE`;
      yield* projections.apply(messageEvent(0, longText));
      const service = yield* ConversationSummaries.ConversationSummaries;
      const first = yield* summarize;
      const handoff = yield* prepareHandoff(MESSAGE_COUNT);
      const input = {
        projectId,
        handoffs: [handoff],
        itemIds: new Set(Array.from({ length: 10 }, (_, index) => itemId(index))),
      };
      assert.deepEqual(yield* service.forHandoff(input), []);
      assert.isTrue(first.hasMore);
      let hasMore: boolean = first.hasMore;
      for (let pass = 0; pass < 8 && hasMore; pass++) hasMore = (yield* summarize).hasMore;
      assert.isFalse(hasMore);
      const ordinary = new Set(Array.from({ length: MESSAGE_COUNT }, (_, index) => rawText(index)));
      const supplied = model.calls
        .filter((call) => !isRollup(call))
        .flatMap((call) => call.messages)
        .filter((message) => !ordinary.has(message.text));
      assert.equal(supplied.map((message) => message.text).join(""), longText);
      assert.isTrue(
        supplied.every((message) => message.text.length <= 6_000 && message.text.isWellFormed()),
      );
      assert.isTrue(
        model.calls.every(
          (call) => call.messages.reduce((sum, message) => sum + message.text.length, 0) <= 32_000,
        ),
      );
      const summaries = (yield* list).summaries.flatMap((read) =>
        read.state === "available" ? [read.summary] : [],
      );
      const leaves = summaries.filter((summary) =>
        summary.sources.every((source) => source.kind !== "summary"),
      );
      assert.isAbove(leaves.length, 3);
      const starts = leaves.map((summary) => {
        const first = summary.sources[0]!;
        return first.kind === "summary" ? 0 : (first.range?.start ?? 0);
      });
      assert.deepEqual(
        starts,
        starts.toSorted((a, b) => a - b),
      );
      const pagedIds: Array<string> = [];
      let cursor: string | undefined;
      do {
        const page = yield* service.list({
          ...scope,
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        pagedIds.push(
          ...page.summaries.flatMap((read) =>
            read.state === "available" ? [read.summary.id] : [],
          ),
        );
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      assert.deepEqual(
        pagedIds,
        summaries.map((summary) => summary.id),
      );
      assert.isTrue(
        summaries.every((summary) =>
          summary.statements.every((statement) =>
            statement.citations.every((citation) =>
              summary.sources.some((source) => conversationSummarySourceKey(source) === citation),
            ),
          ),
        ),
      );
      const offers = yield* service.forHandoff(input);
      assert.equal(offers.length, 1);
      assert.sameMembers([...offers[0]!.coveredItemIds], [...input.itemIds]);
    }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
  },
);

it.effect(
  "keeps scrubbed summaries stale after a source reverts and regenerates their text",
  () => {
    const model = citing();
    return Effect.gen(function* () {
      yield* seed;
      yield* summarize;
      const summary = yield* onlySummary;
      const service = yield* ConversationSummaries.ConversationSummaries;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* projections.apply(messageEvent(0, "Changed source"));
      assert.equal((yield* service.describe({ ...scope, summaryId: summary.id })).state, "stale");
      yield* projections.apply(messageEvent(0, rawText(0)));
      assert.equal((yield* service.describe({ ...scope, summaryId: summary.id })).state, "stale");
      yield* summarize;
      assert.equal(model.calls.length, 2);
      const regenerated = yield* onlySummary;
      assert.equal(regenerated.statements[0]!.text, summary.statements[0]!.text);
      assert.notInclude(regenerated.statements[0]!.text, "Source unavailable");
    }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
  },
);

it.effect("scrubs legacy binary-derived summaries and regenerates clean evidence", () => {
  const model = citing();
  return Effect.gen(function* () {
    yield* seed;
    yield* summarize;
    const previous = yield* onlySummary;
    const binary = "iVBORw0KGgo".repeat(200);
    const text = `Keep the important decision. data:image/png;base64,${binary} Continue with the retry fix.`;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* projections.apply(messageEvent(0, text));
    const crypto = yield* Digest.Digest;
    const digest = Hex.encode(yield* crypto.digest(Digest.sha256, new TextEncoder().encode(text)));
    const legacy = {
      ...previous,
      sources: previous.sources.map((source, index) =>
        index === 0
          ? {
              ...source,
              digest,
              range: { start: 0, end: text.length, total: text.length },
            }
          : source,
      ),
      statements: [
        { text: "Polluted binary attachment claim", citations: previous.statements[0]!.citations },
      ],
    };
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE conversation_summaries SET payload_json = ${yield* encodeSummary(legacy)} WHERE summary_id = ${legacy.id}`;
    const service = yield* ConversationSummaries.ConversationSummaries;
    assert.deepEqual((yield* service.search({ projectId, query: "polluted" })).summaries, []);
    assert.equal((yield* service.describe({ ...scope, summaryId: legacy.id })).state, "stale");
    const original = yield* service.expand({ ...scope, summaryId: legacy.id });
    assert.notInclude(JSON.stringify(original), binary);
    yield* summarize;
    assert.equal(model.calls.length, 2);
    const regenerated = yield* onlySummary;
    const expanded = yield* service.expand({ ...scope, summaryId: regenerated.id });
    assert.notInclude(JSON.stringify(model.calls[1]), binary);
    assert.notInclude(JSON.stringify(expanded), binary);
    assert.include(JSON.stringify(expanded), "Keep the important decision.");
    assert.include(JSON.stringify(expanded), "Continue with the retry fix.");
    assert.equal((yield* service.search({ projectId, query: "polluted" })).summaries.length, 0);
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect("regenerates legacy prefix summaries while keeping their full source recoverable", () => {
  const model = citing();
  return Effect.gen(function* () {
    yield* seed;
    yield* summarize;
    const previous = yield* onlySummary;
    const text = `${"Legacy text. ".repeat(1_000)}EXACT-TAIL`;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* projections.apply(messageEvent(0, text));
    const crypto = yield* Digest.Digest;
    const digest = Hex.encode(yield* crypto.digest(Digest.sha256, new TextEncoder().encode(text)));
    const legacy = {
      ...previous,
      sources: previous.sources.map((source, index) =>
        index === 0 ? { ...source, digest } : source,
      ),
    };
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE conversation_summaries SET payload_json = ${yield* encodeSummary(legacy)} WHERE summary_id = ${legacy.id}`;
    const service = yield* ConversationSummaries.ConversationSummaries;
    assert.equal((yield* service.describe({ ...scope, summaryId: legacy.id })).state, "stale");
    const original = yield* service.expand({
      ...scope,
      summaryId: legacy.id,
      limit: 1,
      maxChars: 257,
    });
    assert.equal(
      original.sources[0]?.result.state === "available" ? original.sources[0].result.text : null,
      text.slice(0, 257),
    );
    assert.equal(original.nextOffset, 0);
    assert.equal(original.nextTextOffset, 257);
    yield* summarize;
    const replacement = yield* onlySummary;
    assert.notEqual(replacement.id, legacy.id);
    assert.isTrue(
      replacement.sources.some((source) => source.kind !== "summary" && source.range !== undefined),
    );
    assert.include(
      model.calls
        .at(-1)
        ?.messages.map((message) => message.text)
        .join(""),
      "EXACT-TAIL",
    );
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect(
  "includes canonical command evidence and invalidates it when command output changes",
  () => {
    const model = citing();
    return Effect.gen(function* () {
      yield* seed;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const command: Extract<OrchestrationV2TurnItem, { type: "command_execution" }> = {
        ...item(0),
        id: TurnItemId.make("test-command"),
        type: "command_execution",
        ordinal: 20,
        input: "vp test run regression.test.ts",
        output: "3 tests failed: suffix regression",
        exitCode: 1,
        completedAt: DateTime.add(at, { minutes: 3, seconds: 30 }),
      };
      const event: Extract<OrchestrationV2DomainEvent, { type: "turn-item.updated" }> = {
        id: EventId.make("test-command-complete"),
        type: "turn-item.updated",
        threadId,
        providerInstanceId: instanceId,
        occurredAt: at,
        payload: command,
      };
      yield* projections.apply(event);
      yield* summarize;
      const supplied = model.calls
        .flatMap((call) => call.messages)
        .find((message) => message.role === "tool");
      assert.include(supplied?.text, "3 tests failed: suffix regression");
      const summary = yield* onlySummary;
      const index = summary.sources.findIndex(
        (source) => source.kind === "turn_item" && source.itemId === command.id,
      );
      assert.isAtLeast(index, 0);
      const service = yield* ConversationSummaries.ConversationSummaries;
      const expansion = yield* service.expand({
        ...scope,
        summaryId: summary.id,
        offset: index,
        limit: 1,
      });
      assert.equal(
        expansion.sources[0]?.result.state === "available"
          ? expansion.sources[0].result.text
          : null,
        supplied?.text,
      );
      const stale = {
        ...summary,
        id: `summary:${"f".repeat(64)}`,
        sources: summary.sources.map((source) =>
          source.kind === "turn_item" ? { ...source, digest: "0".repeat(64) } : source,
        ),
      };
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO conversation_summaries
        (summary_id, project_id, thread_id, position, created_at, payload_json)
        SELECT ${stale.id}, project_id, thread_id, position || ':stale', created_at, ${yield* encodeSummary(stale)}
        FROM conversation_summaries WHERE summary_id = ${summary.id}`;
      assert.deepEqual(
        (yield* service.search({ projectId, query: "exact", limit: 20 })).summaries.map(
          (hit) => hit.id,
        ),
        [summary.id],
      );
      yield* projections.apply({
        ...event,
        id: EventId.make("test-command-edited"),
        payload: { ...command, output: "Now different" },
      });
      assert.equal((yield* service.describe({ ...scope, summaryId: summary.id })).state, "stale");
      assert.deepEqual(
        (yield* service.expand({ ...scope, summaryId: summary.id, offset: index, limit: 1 }))
          .sources[0]?.result,
        { state: "unavailable", reason: "changed" },
      );
    }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
  },
);

it.effect(
  "excludes cancelled queued input from generation and previously generated summaries",
  () => {
    const model = citing();
    return Effect.gen(function* () {
      yield* seed;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const queued = item(0);
      if (queued.type !== "user_message") return yield* Effect.die("Expected a user message");
      yield* projections.apply({
        id: EventId.make("queued-source-item"),
        type: "turn-item.updated",
        threadId,
        providerInstanceId: instanceId,
        occurredAt: at,
        payload: { ...queued, inputIntent: "queued_turn" },
      });
      const run: Extract<OrchestrationV2DomainEvent, { type: "run.updated" }> = {
        id: EventId.make("queued-source-run"),
        type: "run.updated",
        threadId,
        runId,
        providerInstanceId: instanceId,
        occurredAt: at,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "gpt-5" },
          providerThreadId: null,
          userMessageId: messageId(0),
          rootNodeId: NodeId.make("queued-source-root"),
          activeAttemptId: null,
          status: "completed",
          requestedAt: at,
          startedAt: at,
          completedAt: at,
          checkpointId: null,
          contextHandoffId: null,
        },
      };
      yield* projections.apply(run);
      yield* summarize;
      const summary = yield* onlySummary;
      yield* projections.apply({
        ...run,
        id: EventId.make("queued-source-cancelled"),
        payload: { ...run.payload, status: "cancelled" },
      });
      const service = yield* ConversationSummaries.ConversationSummaries;
      assert.equal((yield* service.describe({ ...scope, summaryId: summary.id })).state, "stale");
      assert.deepEqual(
        (yield* service.expand({ ...scope, summaryId: summary.id, limit: 1 })).sources[0]?.result,
        { state: "unavailable", reason: "missing" },
      );
      yield* summarize;
      assert.equal(model.calls.length, 2);
      assert.isTrue(model.calls[1]!.messages.every((message) => message.text !== rawText(0)));
      const current = (yield* list).summaries.flatMap((read) =>
        read.state === "available" ? [read.summary] : [],
      );
      assert.equal(current.length, 1);
      assert.equal(current[0]!.sources.length, 9);
      assert.isFalse(
        current[0]!.sources.some(
          (source) => source.kind === "message" && source.messageId === messageId(0),
        ),
      );
    }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
  },
);

it.effect("does not offer tool-only evidence from a deleted project", () => {
  const model = citing();
  return Effect.gen(function* () {
    yield* seedThread(6);
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const command: Extract<OrchestrationV2TurnItem, { type: "command_execution" }> = {
      ...item(0),
      id: TurnItemId.make("tool-only-command"),
      type: "command_execution",
      input: "vp test run",
      output: "Check output. ".repeat(600),
      exitCode: 0,
      completedAt: DateTime.subtract(at, { minutes: 1 }),
    };
    yield* projections.apply({
      id: EventId.make("tool-only-command-completed"),
      type: "turn-item.updated",
      threadId,
      providerInstanceId: instanceId,
      occurredAt: at,
      payload: command,
    });
    yield* summarize;
    const summary = yield* onlySummary;
    assert.isTrue(summary.sources.every((source) => source.kind === "turn_item"));
    const service = yield* ConversationSummaries.ConversationSummaries;
    const rpc = conversationSummariesRpcHandlers(service);
    const modern = yield* rpc[WS_METHODS.conversationSummariesList]({ ...scope, sourceFormat: 2 });
    assert.throws(() => decodeLegacyList(encodeSummaryListWire(modern)));
    assertLegacyUpgradeError(
      yield* rpc[WS_METHODS.conversationSummariesList](scope).pipe(Effect.flip),
    );
    assertLegacyUpgradeError(
      yield* rpc[WS_METHODS.conversationSummariesDescribe]({
        ...scope,
        summaryId: summary.id,
      }).pipe(Effect.flip),
    );
    assertLegacyUpgradeError(
      yield* rpc[WS_METHODS.conversationSummariesExpand]({ ...scope, summaryId: summary.id }).pipe(
        Effect.flip,
      ),
    );
    const evidence = yield* rpc[WS_METHODS.conversationSummariesExpand]({
      ...scope,
      summaryId: summary.id,
      sourceFormat: 2,
    });
    assert.isTrue(
      evidence.sources.every(
        (source) => source.result.state === "available" && source.result.role === "tool",
      ),
    );
    const input = {
      projectId,
      handoffs: [yield* prepareHandoff(6, [command])],
      itemIds: new Set([command.id]),
    };
    assert.equal((yield* service.forHandoff(input)).length, 1);
    const projects = yield* ProjectStore.ProjectStoreV2;
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make("summary-project-deleted"),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(at),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.deleted",
      payload: { projectId, deletedAt: DateTime.formatIso(at) },
    });
    assert.deepEqual(yield* service.forHandoff(input), []);
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect("finds summaries across project threads and expands each hit in its own scope", () =>
  Effect.gen(function* () {
    yield* seed;
    const first = yield* persistSummary(1, [0]);
    const siblingId = ThreadId.make("sibling-thread");
    const siblingMessageId = MessageId.make("sibling-message");
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* projections.apply({
      id: EventId.make("sibling-created"),
      type: "thread.created",
      threadId: siblingId,
      providerInstanceId: instanceId,
      occurredAt: at,
      payload: { ...threadPayload, id: siblingId },
    });
    const original = messageEvent(0, rawText(0));
    if (original.type !== "message.updated") throw new Error("Expected a message event");
    yield* projections.apply({
      ...original,
      id: EventId.make("sibling-message-created"),
      threadId: siblingId,
      payload: { ...original.payload, id: siblingMessageId, threadId: siblingId },
    });
    const sibling = {
      ...first,
      id: `summary:${"b".repeat(64)}`,
      threadId: siblingId,
      sources: [
        {
          kind: "message" as const,
          threadId: siblingId,
          messageId: siblingMessageId,
          digest: first.sources[0]!.kind === "message" ? first.sources[0]!.digest : "",
        },
      ],
      statements: [{ text: "Summary sibling", citations: [siblingMessageId] }],
    };
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO conversation_summaries
      (summary_id, project_id, thread_id, position, created_at, payload_json)
      VALUES (${sibling.id}, ${projectId}, ${siblingId}, 'sibling', ${sibling.createdAt}, ${yield* encodeSummary(sibling)})`;
    const foreignProjectId = ProjectId.make("other-project");
    const foreignThreadId = ThreadId.make("other-project-thread");
    const foreignMessageId = MessageId.make("other-project-message");
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      SELECT ${foreignProjectId}, title, '/work/other', scripts_json, created_at, updated_at
      FROM projection_projects WHERE project_id = ${projectId}`;
    yield* projections.apply({
      id: EventId.make("foreign-created"),
      type: "thread.created",
      threadId: foreignThreadId,
      providerInstanceId: instanceId,
      occurredAt: at,
      payload: { ...threadPayload, id: foreignThreadId, projectId: foreignProjectId },
    });
    yield* projections.apply({
      ...original,
      id: EventId.make("foreign-message-created"),
      threadId: foreignThreadId,
      payload: {
        ...original.payload,
        id: foreignMessageId,
        threadId: foreignThreadId,
        runId: null,
      },
    });
    const foreign = {
      ...sibling,
      id: `summary:${"0".repeat(64)}`,
      projectId: foreignProjectId,
      threadId: foreignThreadId,
      createdAt: DateTime.formatIso(DateTime.add(at, { minutes: 1 })),
      sources: [{ ...sibling.sources[0]!, threadId: foreignThreadId, messageId: foreignMessageId }],
      statements: [{ text: "Summary foreign", citations: [foreignMessageId] }],
    };
    yield* sql`INSERT INTO conversation_summaries
      (summary_id, project_id, thread_id, position, created_at, payload_json)
      VALUES (${foreign.id}, ${foreignProjectId}, ${foreignThreadId}, 'foreign', ${foreign.createdAt}, ${yield* encodeSummary(foreign)})`;
    const service = yield* ConversationSummaries.ConversationSummaries;
    const result = yield* service.search({ projectId, query: "summary" });
    assert.deepEqual(
      result.summaries.map((summary) => summary.id),
      [first.id, sibling.id],
    );
    const page = yield* service.search({ projectId, query: "summary", limit: 1 });
    assert.deepEqual(
      page.summaries.map((hit) => hit.id),
      [first.id],
    );
    assert.isNotNull(page.nextCursor);
    assert.deepEqual(
      (yield* service.search({
        projectId: foreignProjectId,
        query: "summary",
        limit: 1,
      })).summaries.map((hit) => hit.id),
      [foreign.id],
    );
    for (const changedScope of [
      { projectId: foreignProjectId },
      { projectId, threadId: siblingId },
    ]) {
      assert.equal(
        (yield* service
          .search({ ...changedScope, query: "summary", cursor: page.nextCursor! })
          .pipe(Effect.flip)).reason,
        "invalid_cursor",
      );
    }
    yield* sql`UPDATE projection_projects SET archived_at = ${DateTime.formatIso(at)} WHERE project_id = ${foreignProjectId}`;
    assert.equal(
      (yield* service.search({ projectId: foreignProjectId, query: "summary" })).summaries[0]?.id,
      foreign.id,
    );
    yield* sql`UPDATE projection_projects SET deleted_at = ${DateTime.formatIso(at)} WHERE project_id = ${foreignProjectId}`;
    assert.equal(
      (yield* service.search({ projectId: foreignProjectId, query: "summary" }).pipe(Effect.flip))
        .reason,
      "missing_project",
    );
    const scoped = yield* service.search({ ...scope, query: "summary" });
    assert.deepEqual(
      scoped.summaries.map((summary) => summary.id),
      [first.id],
    );
    const expanded = yield* service.expand({
      projectId,
      threadId: siblingId,
      summaryId: sibling.id,
    });
    assert.equal(
      expanded.sources[0]?.result.state === "available" ? expanded.sources[0].result.text : null,
      rawText(0),
    );
    assert.equal(
      (yield* service.expand({ ...scope, summaryId: sibling.id }).pipe(Effect.flip)).reason,
      "missing_summary",
    );
  }).pipe(Effect.provide(makeLayer(citing().generate, optedIn))),
);

it.effect("bounds search previews around matches and keeps their evidence handles usable", () =>
  Effect.gen(function* () {
    yield* seedThread(24);
    const sql = yield* SqlClient.SqlClient;
    for (let index = 0; index < 21; index++) {
      const summary = yield* persistSummary(
        index,
        Array.from({ length: 24 }, (_, source) => source),
      );
      const statements = Array.from({ length: 8 }, (_, statement) => ({
        text:
          statement >= 6
            ? `${statement === 6 ? "Needle" : "Tail"} ${"🧪".repeat(280)}`
            : `Filler ${statement}: ${"padding ".repeat(70)}`.trim(),
        citations: summary.statements[0]!.citations,
      }));
      yield* sql`UPDATE conversation_summaries SET payload_json = ${yield* encodeSummary({ ...summary, statements })}
        WHERE summary_id = ${summary.id}`;
    }
    const service = yield* ConversationSummaries.ConversationSummaries;
    const defaults = yield* service.search({ projectId, query: "needle" });
    const trace = traceSqlRouting();
    const maximum = yield* trace.trace(service.search({ projectId, query: "needle", limit: 20 }));
    const sourceReads = trace.queries.filter(
      ({ query }) =>
        query.includes("orchestration_v2_projection_messages") && query.includes("payload_json"),
    );
    assert.isAbove(sourceReads.length, 0);
    assert.isAtMost(sourceReads.length, 2);
    assert.equal(defaults.summaries.length, 10);
    assert.equal(maximum.summaries.length, 20);
    for (const page of [defaults, maximum]) {
      assert.isNotNull(page.nextCursor);
      for (const hit of page.summaries) {
        assert.doesNotHaveAnyKeys(hit, ["sources", "statements", "modelSelection"]);
        assert.include(hit.excerpt, "Needle");
        assert.isAtMost(hit.excerpt.length, 1_000);
        assert.isTrue(hit.excerpt.isWellFormed());
        assert.isTrue(hit.truncated);
        assert.equal(hit.sourceCount, 24);
        assert.equal(hit.kind, "leaf");
      }
      assert.isAtMost(
        page.summaries.reduce((length, hit) => length + hit.excerpt.length, 0),
        page === defaults ? 10_000 : 20_000,
      );
    }
    const selected = defaults.summaries[0]!;
    const handle = {
      projectId: selected.projectId,
      threadId: selected.threadId,
      summaryId: selected.id,
    };
    const full = yield* service.describe(handle);
    assert.equal(full.state === "available" ? full.summary.statements.length : 0, 8);
    const expanded = yield* service.expand({ ...handle, maxChars: 1_000 });
    assert.equal(expanded.sources[0]?.result.state, "available");
  }).pipe(Effect.provide(makeLayer(citing().generate, optedIn))),
);

it.effect("continues summary search after a bounded page of stale candidates", () =>
  Effect.gen(function* () {
    yield* seed;
    for (let index = 0; index < 101; index++) yield* persistSummary(index, [0], true);
    const current = yield* persistSummary(101, [1]);
    const service = yield* ConversationSummaries.ConversationSummaries;
    const first = yield* service.search({ projectId, query: "summary", limit: 1 });
    assert.deepEqual(first.summaries, []);
    assert.isNotNull(first.nextCursor);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM conversation_summaries WHERE json_extract(payload_json, '$.scrubbed') = 1`;
    const second = yield* service.search({
      projectId,
      query: "summary",
      limit: 1,
      cursor: first.nextCursor!,
    });
    assert.deepEqual(
      second.summaries.map((summary) => summary.id),
      [current.id],
    );
    assert.isNull(second.nextCursor);
  }).pipe(Effect.provide(makeLayer(citing().generate, optedIn))),
);

it.effect("ranks a focused older summary above newer passing mentions and pages exactly", () =>
  Effect.gen(function* () {
    yield* seedThread(24);
    const sql = yield* SqlClient.SqlClient;
    const restate = Effect.fn(function* (
      summary: ConversationSummary,
      text: string,
      minute: number,
    ) {
      const statements = [{ text, citations: summary.statements[0]!.citations }];
      yield* sql`UPDATE conversation_summaries
        SET created_at = ${DateTime.formatIso(DateTime.add(at, { minutes: minute }))},
          payload_json = ${yield* encodeSummary({ ...summary, statements })}
        WHERE summary_id = ${summary.id}`;
    });
    const passing = (index: number) =>
      `Run ${index} rebuilt the dashboard. ${"Unrelated layout work. ".repeat(20)}One kernel xattr warning.`;
    const focused = yield* persistSummary(0, [0]);
    yield* restate(focused, "Kernel xattr support stays out of scope for the kernel client.", 0);
    const noisy: Array<ConversationSummary> = [];
    for (let index = 1; index <= 12; index++) {
      noisy.push(yield* persistSummary(index, [index]));
      yield* restate(noisy.at(-1)!, passing(index), index);
    }
    for (let index = 13; index <= 15; index++) {
      yield* restate(yield* persistSummary(index, [index], true), passing(index), index);
    }
    const service = yield* ConversationSummaries.ConversationSummaries;
    const query = { projectId, query: "kernel xattr", limit: 3 };
    const first = yield* service.search(query);
    assert.equal(first.summaries[0]?.id, focused.id);

    const seen = first.summaries.map((hit) => hit.id);
    const removed = noisy.find((summary) => !seen.includes(summary.id))!;
    yield* sql`DELETE FROM conversation_summaries WHERE summary_id = ${removed.id}`;
    for (let index = 16; index <= 23; index++) {
      yield* restate(
        yield* persistSummary(index, [index]),
        `${"kernel ".repeat(index)}xattr`,
        100 + index,
      );
    }
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = yield* service.search({ ...query, limit: 2, cursor });
      seen.push(...page.summaries.map((hit) => hit.id));
      cursor = page.nextCursor;
    }
    assert.equal(new Set(seen).size, seen.length);
    assert.notInclude(seen, removed.id);
    for (const summary of [focused, ...noisy]) {
      if (summary !== removed) assert.include(seen, summary.id);
    }
    const tokens = Array.from({ length: 128 }, (_, index) => String.fromCodePoint(0x4e00 + index));
    for (const summary of [focused, noisy.find((entry) => entry !== removed)!]) {
      yield* restate(summary, tokens.join(" "), 200);
    }
    const longQuery = { projectId, threadId, query: tokens.join("\u0001"), limit: 1 };
    const longPage = yield* service.search(longQuery);
    assert.isNotNull(longPage.nextCursor);
    const nextInput = yield* decodeSummarySearchInput({
      ...longQuery,
      cursor: longPage.nextCursor,
    });
    const nextPage = yield* service.search(nextInput);
    assert.lengthOf(nextPage.summaries, 1);
    assert.notEqual(nextPage.summaries[0]!.id, longPage.summaries[0]!.id);
  }).pipe(Effect.provide(makeLayer(citing().generate, optedIn))),
);

it.effect("searches project summaries by indexed terms and excludes stale or hidden evidence", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* ConversationSummaries.ConversationSummaries;
    const sql = yield* SqlClient.SqlClient;
    const first = yield* persistSummary(1, [0]);
    const second = yield* persistSummary(2, [1]);
    const stale = yield* persistSummary(3, [2], true);
    for (const summary of [first, second, stale]) {
      yield* sql`UPDATE conversation_summaries SET payload_json = ${yield* encodeSummary({
        ...summary,
        statements: [
          {
            text: "Kernel extended attributes: résumé café",
            citations: summary.statements[0]!.citations,
          },
        ],
      })} WHERE summary_id = ${summary.id}`;
    }
    const query = { projectId, query: "kernel café", limit: 1 };
    const page = yield* service.search(query);
    assert.equal(page.summaries[0]?.excerpt, "Kernel extended attributes: résumé café");
    assert.isFalse(page.summaries[0]?.truncated);
    assert.deepEqual(
      page.summaries.map((summary) => summary.id),
      [first.id],
    );
    assert.isNotNull(page.nextCursor);
    const next = yield* service.search({ ...query, cursor: page.nextCursor! });
    assert.deepEqual(
      next.summaries.map((summary) => summary.id),
      [second.id],
    );
    const end =
      next.nextCursor === null
        ? next
        : yield* service.search({ ...query, cursor: next.nextCursor });
    assert.isNull(end.nextCursor);
    assert.equal(
      (yield* service.search({ projectId, query: "RESUME kernel" })).summaries.length,
      2,
    );
    assert.equal(
      (yield* service.search({ projectId, query: 'kernel OR "missing"' })).summaries.length,
      0,
    );
    assert.equal((yield* service.search({ projectId, query: "* % : ()" })).summaries.length, 0);
    assert.equal(
      (yield* service.search({ projectId, threadId: ThreadId.make("other"), query: "kernel" }))
        .summaries.length,
      0,
    );
    assert.equal(
      (yield* service
        .search({ ...query, query: "different", cursor: page.nextCursor! })
        .pipe(Effect.flip)).reason,
      "invalid_cursor",
    );
    assert.equal(
      (yield* service.search({ ...query, cursor: "not a cursor" }).pipe(Effect.flip)).reason,
      "invalid_cursor",
    );
    yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = ${DateTime.formatIso(at)} WHERE thread_id = ${threadId}`;
    assert.deepEqual((yield* service.search({ projectId, query: "kernel" })).summaries, []);
    yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = NULL, deleted_at = ${DateTime.formatIso(at)} WHERE thread_id = ${threadId}`;
    assert.deepEqual((yield* service.search({ projectId, query: "kernel" })).summaries, []);
  }).pipe(Effect.provide(makeLayer(citing().generate, optedIn))),
);

it.effect(
  "searches statements literally and expands source text within a resumable character budget",
  () => {
    const model = citing();
    return Effect.gen(function* () {
      yield* seed;
      yield* summarize;
      const summary = yield* onlySummary;
      const service = yield* ConversationSummaries.ConversationSummaries;
      assert.equal((yield* service.list({ ...scope, query: "EXACT TEXT" })).summaries.length, 1);
      assert.equal((yield* service.list({ ...scope, query: "%" })).summaries.length, 0);
      assert.equal((yield* service.list({ ...scope, query: "unrelated" })).summaries.length, 0);
      const emojiOffset = rawText(0).indexOf("🧪");
      const emoji = yield* service.expand({
        ...scope,
        summaryId: summary.id,
        textOffset: emojiOffset,
        maxChars: 2,
      });
      assert.equal(
        emoji.sources[0]?.result.state === "available" ? emoji.sources[0].result.text : null,
        "🧪",
      );
      assert.equal(emoji.nextOffset, 0);
      assert.equal(emoji.nextTextOffset, emojiOffset + 2);
      const invalid = yield* service
        .expand({ ...scope, summaryId: summary.id, textOffset: emojiOffset + 1 })
        .pipe(Effect.flip);
      assert.equal(invalid.reason, "invalid_cursor");
      let offset: number | null = 0;
      let textOffset = 0;
      const restored = new Map<string, string>();
      let pages = 0;
      while (offset !== null && pages < 100) {
        const page: ConversationSummaryExpansion = yield* service.expand({
          ...scope,
          summaryId: summary.id,
          offset,
          textOffset,
          maxChars: 257,
          limit: 3,
        });
        const text = page.sources.flatMap((source) =>
          source.result.state === "available" ? [source.result.text] : [],
        );
        assert.isAtMost(text.join("").length, 257);
        assert.isTrue(text.every((part) => part.isWellFormed()));
        for (const source of page.sources)
          if (source.result.state === "available") {
            const key = conversationSummarySourceKey(source.ref);
            restored.set(key, (restored.get(key) ?? "") + source.result.text);
          }
        offset = page.nextOffset;
        textOffset = page.nextTextOffset ?? 0;
        pages += 1;
      }
      assert.isNull(offset);
      assert.isAbove(pages, 10);
      for (let index = 0; index < 10; index++)
        assert.equal(restored.get(messageId(index)), rawText(index));
    }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
  },
);

it.effect("records and retries a source change during model generation", () => {
  let changeSource: Effect.Effect<void> = Effect.void;
  const model = scripted(() =>
    changeSource.pipe(
      Effect.as({
        statements: [{ text: "A statement about the prior source.", citations: ["M1"] }],
      }),
    ),
  );
  return Effect.gen(function* () {
    yield* seed;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    changeSource = projections
      .apply(messageEvent(0, "Changed during the model call"))
      .pipe(Effect.orDie);
    assert.instanceOf(yield* summarize.pipe(Effect.flip), ConversationSummaryPassError);
    const result = yield* list;
    assert.deepEqual(result.summaries, []);
    assert.deepInclude(result.lastPass, { result: "failed", generated: 0, waitingMessages: 10 });
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect("rolls up covered roots before summarizing a later uncovered stretch", () => {
  const model = citing();
  return Effect.gen(function* () {
    const coveredLeaves = 8;
    const uncovered = 10;
    yield* seedThread(coveredLeaves * 2 + uncovered + 6);
    for (let index = 0; index < coveredLeaves; index++)
      yield* persistSummary(index, [index * 2, index * 2 + 1]);
    yield* summarize;
    assert.equal(model.calls.length, 3);
    assert.isTrue(isRollup(model.calls[0]!));
    assert.isTrue(isRollup(model.calls[1]!));
    assert.equal(model.calls[0]!.messages.length, 4);
    assert.equal(model.calls[2]!.messages[0]!.text, rawText(coveredLeaves * 2));
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect("replaces a leaf beside a gap before rolling roots across that gap", () => {
  const model = citing();
  return Effect.gen(function* () {
    yield* seedThread(22);
    for (let index = 0; index < 8; index++)
      yield* persistSummary(index, [index * 2, index * 2 + 1], index === 3);
    yield* summarize;
    assert.isFalse(isRollup(model.calls[0]!));
    assert.equal(model.calls[0]!.messages[0]!.text, rawText(6));
    assert.isFalse(
      model.calls.some(
        (call) =>
          isRollup(call) &&
          call.messages.some((message) => message.text.includes("Summary 2")) &&
          call.messages.some((message) => message.text.includes("Summary 4")),
      ),
    );
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
    assert.isTrue(isRollup(model.calls[0]!));
    // Summary 501 covers the two messages just before the uncovered stretch. If the page hid it,
    // those messages would be waiting too.
    assert.deepInclude((yield* list).lastPass, { waitingMessages: 10 });

    const service = yield* ConversationSummaries.ConversationSummaries;
    const sql = yield* SqlClient.SqlClient;
    const lastId = `summary:${(summaryCount - 1).toString(16).padStart(64, "0")}`;
    yield* sql`UPDATE conversation_summaries SET payload_json = json_set(payload_json, '$.statements[0].text', 'Summary 500 RÉSUMÉ') WHERE summary_id = ${lastId}`;
    const unicode = yield* service.list({ ...scope, query: "résumé" });
    assert.equal(unicode.summaries.length, 1);
    assert.equal(
      unicode.summaries[0]?.state === "available" ? unicode.summaries[0].summary.id : null,
      lastId,
    );
    const firstMatch = yield* service.list({ ...scope, query: "SUMMARY 50", limit: 1 });
    assert.isNotNull(firstMatch.nextCursor);
    const secondMatch = yield* service.list({
      ...scope,
      query: "SUMMARY 50",
      limit: 1,
      cursor: firstMatch.nextCursor!,
    });
    assert.equal(
      secondMatch.summaries[0]?.state === "available" ? secondMatch.summaries[0].summary.id : null,
      lastId,
    );
    assert.isNull(secondMatch.nextCursor);
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

it.effect("offers the summaries nearest the present first, within the candidate limit", () => {
  const model = citing();
  return Effect.gen(function* () {
    const summaryCount = 45;
    yield* seedThread(summaryCount * 2 + 6);
    for (let index = 0; index < summaryCount; index++)
      yield* persistSummary(index, [index * 2, index * 2 + 1]);
    const service = yield* ConversationSummaries.ConversationSummaries;
    const offered = yield* service.forHandoff({
      projectId,
      handoffs: [yield* prepareHandoff(summaryCount * 2 + 6)],
      itemIds: new Set(Array.from({ length: summaryCount * 2 }, (_, index) => itemId(index))),
    });
    assert.equal(offered.length, 40);
    assert.deepEqual(offered[0]!.coveredItemIds, [itemId(88), itemId(89)]);
    assert.deepEqual(offered.at(-1)!.coveredItemIds, [itemId(10), itemId(11)]);
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect("hands off almost all omitted history of a 600-item thread as summaries", () => {
  const model = verbose();
  return Effect.gen(function* () {
    const itemCount = 600;
    const settledCount = itemCount - 6;
    yield* seedThread(itemCount);
    for (let pass = 0, hasMore = true; hasMore; pass++) {
      assert.isBelow(pass, 60, "the pass converges");
      hasMore = (yield* summarize).hasMore;
    }
    const rollups = model.calls.filter(isRollup);
    assert.isAbove(rollups.length, 0);
    for (const call of rollups)
      assert.equal(call.messages.length, 4, "one call per four summaries");
    const spent = model.calls.length;
    yield* summarize;
    assert.equal(
      model.calls.length,
      spent,
      "a repeated pass over unchanged sources spends nothing",
    );

    const service = yield* ConversationSummaries.ConversationSummaries;
    const handoff = yield* prepareHandoff(itemCount);
    const deliver = Effect.fn("test.deliverLongThread")(function* (withSummaries: boolean) {
      let verbatim: ReadonlyArray<{ readonly itemId: TurnItemId; readonly text: string }> = [];
      let summarized: ReadonlyArray<TurnItemId> = [];
      yield* deliverContextHandoffs({
        handoffs: [handoff],
        providerThread,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set(),
        ...(withSummaries
          ? {
              summaries: (itemIds: ReadonlySet<string>) =>
                service.forHandoff({ projectId, handoffs: [handoff], itemIds }),
            }
          : {}),
        inject: (history) =>
          Effect.sync(() => {
            verbatim = history.messages;
            return true;
          }),
        persist: (next) =>
          Effect.sync(() => {
            summarized = next.delivery?.summarizedItemIds ?? [];
          }),
      });
      return { verbatim, summarized: new Set(summarized) };
    });
    const baseline = yield* deliver(false);
    const delivered = yield* deliver(true);
    const verbatimIds = new Set(baseline.verbatim.map((message) => message.itemId));
    const omitted = Array.from({ length: settledCount }, (_, index) => itemId(index)).filter(
      (id) => !verbatimIds.has(id),
    );
    const represented = omitted.filter((id) => delivered.summarized.has(id));
    assert.isAtLeast(represented.length / omitted.length, 0.9);
    for (let index = settledCount; index < itemCount; index++)
      assert.equal(
        delivered.verbatim.find((message) => message.itemId === itemId(index))?.text,
        rawText(index),
        "the six newest messages arrive word for word",
      );
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect("rebuilds only the broken path of a roll-up and expands it to the exact text", () => {
  const model = citing();
  return Effect.gen(function* () {
    // Sixteen two-message leaves roll up into four parents and one grandparent.
    yield* seedThread(38);
    for (let index = 0; index < 16; index++)
      yield* persistSummary(index, [index * 2, index * 2 + 1]);
    const settle = Effect.gen(function* () {
      for (let pass = 0, hasMore = true; hasMore; pass++) {
        assert.isBelow(pass, 10);
        hasMore = (yield* summarize).hasMore;
      }
    });
    yield* settle;
    assert.equal(model.calls.length, 5);
    const service = yield* ConversationSummaries.ConversationSummaries;
    const available = (yield* list).summaries.flatMap((read) =>
      read.state === "available" ? [read.summary] : [],
    );
    const condensed = available.filter((summary) => summary.sources[0]!.kind === "summary");
    const [root, ...parents] = condensed;
    assert.equal(parents.length, 4);
    assert.deepEqual(
      root!.sources.map((source) => (source.kind === "summary" ? source.summaryId : null)),
      parents.map((summary) => summary.id),
    );

    // Each hop follows the first citation down to a message.
    let hop: ConversationSummary = root!;
    for (let depth = 0; depth < 2; depth++) {
      const page = yield* service.expand({ ...scope, summaryId: hop.id });
      const cited = page.sources.findIndex(
        ({ ref }) => conversationSummarySourceKey(ref) === hop.statements[0]!.citations[0],
      );
      const { ref, result } = page.sources[cited]!;
      assert.equal(result.state === "available" ? result.role : null, "summary");
      if (ref.kind !== "summary") throw new Error("Expected a summary source");
      const child = yield* service.describe({ ...scope, summaryId: ref.summaryId });
      if (child.state !== "available") throw new Error("Expected a current child");
      assert.include(
        result.state === "available" ? result.text : "",
        child.summary.statements[0]!.text,
      );
      hop = child.summary;
    }
    const exact = yield* service.expand({ ...scope, summaryId: hop.id, limit: 1 });
    assert.equal(
      exact.sources[0]!.result.state === "available" ? exact.sources[0]!.result.text : null,
      rawText(0),
    );

    const rpc = conversationSummariesRpcHandlers(service);
    const describeRoot = { ...scope, summaryId: root!.id };
    assertLegacyUpgradeError(
      yield* rpc[WS_METHODS.conversationSummariesDescribe]({
        ...describeRoot,
        sourceFormat: 2,
      }).pipe(Effect.flip),
    );
    assert.equal(
      (yield* rpc[WS_METHODS.conversationSummariesDescribe]({ ...describeRoot, sourceFormat: 3 }))
        .state,
      "available",
    );

    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* projections.apply(messageEvent(0, "Edited request"));
    const state = (summaryId: string) =>
      service.describe({ ...scope, summaryId }).pipe(Effect.map((read) => read.state));
    assert.equal(yield* state(root!.id), "stale");
    assert.equal(yield* state(parents[0]!.id), "stale");
    assert.equal(yield* state(parents[1]!.id), "available");
    const handoff = yield* prepareHandoff(38);
    const offered = yield* service.forHandoff({
      projectId,
      handoffs: [handoff],
      itemIds: new Set(Array.from({ length: 32 }, (_, index) => itemId(index))),
    });
    const offeredText = offered.map((offer) => offer.text).join("\n");
    assert.notInclude(offeredText, root!.id);
    assert.notInclude(offeredText, parents[0]!.id);
    assert.include(offeredText, parents[1]!.id);

    yield* settle;
    assert.equal(model.calls.length, 8, "one leaf and one roll-up per broken level");
    const after = (yield* list).summaries;
    for (const kept of parents.slice(1))
      assert.isTrue(
        after.some((read) => read.state === "available" && read.summary.id === kept.id),
      );
    assert.isFalse(after.some((read) => read.state !== "available"));
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect("offers a summary citing uncarried tool evidence only inside the replayed runs", () => {
  const model = citing();
  return Effect.gen(function* () {
    yield* seed;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* projections.apply({
      id: EventId.make("covered-run"),
      type: "run.updated",
      threadId,
      runId,
      providerInstanceId: instanceId,
      occurredAt: at,
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-5" },
        providerThreadId: null,
        userMessageId: messageId(0),
        rootNodeId: NodeId.make("covered-run-root"),
        activeAttemptId: null,
        status: "completed",
        requestedAt: at,
        startedAt: at,
        completedAt: at,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    const tool: Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }> = {
      ...item(0),
      id: TurnItemId.make("uncarried-tool"),
      type: "dynamic_tool",
      toolName: "t3_thread_read",
      input: { view: "activity" },
      output: "Tool output. ".repeat(40),
      completedAt: DateTime.subtract(at, { minutes: 1 }),
    };
    yield* projections.apply({
      id: EventId.make("uncarried-tool-completed"),
      type: "turn-item.updated",
      threadId,
      providerInstanceId: instanceId,
      occurredAt: at,
      payload: tool,
    });
    yield* summarize;
    const summary = yield* onlySummary;
    assert.isTrue(summary.sources.some((source) => source.kind === "turn_item"));
    const carried = summary.sources.flatMap((source) =>
      source.kind === "message" ? [itemId(Number(source.messageId.slice("message-".length)))] : [],
    );
    const service = yield* ConversationSummaries.ConversationSummaries;
    // A recovery handoff reads history without MCP tool results, so it never names this item.
    const handoff = yield* prepareHandoff(MESSAGE_COUNT);
    const input = { projectId, handoffs: [handoff], itemIds: new Set(carried) };
    assert.deepEqual(
      (yield* service.forHandoff({ ...input, replayed: { threadId, from: 1, to: 1 } })).map(
        (offer) => offer.coveredItemIds,
      ),
      [carried],
    );
    assert.deepEqual(
      yield* service.forHandoff({ ...input, replayed: { threadId, from: 2, to: 2 } }),
      [],
      "evidence outside the replayed runs stays out",
    );
    assert.deepEqual(
      yield* service.forHandoff(input),
      [],
      "a handoff record alone never admits history it does not carry",
    );
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

const seedRun = Effect.fn("test.seedSummaryRun")(function* (
  id: RunId,
  ordinal: number,
  owner = threadId,
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  yield* projections.apply({
    id: EventId.make(`run-${id}`),
    type: "run.updated",
    threadId: owner,
    runId: id,
    providerInstanceId: instanceId,
    occurredAt: at,
    payload: {
      id,
      threadId: owner,
      ordinal,
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5" },
      providerThreadId: null,
      userMessageId: messageId(0),
      rootNodeId: NodeId.make(`root-${id}`),
      activeAttemptId: null,
      status: "completed",
      requestedAt: at,
      startedAt: at,
      completedAt: at,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
});

it.effect("does not read a fork delta's run ordinals as covering uncarried history", () => {
  const model = citing();
  return Effect.gen(function* () {
    yield* seed;
    yield* persistSummary(0, [0, 1]);
    yield* seedRun(runId, 1);
    const handoffs = yield* ContextHandoffService.ContextHandoffServiceV2;
    const service = yield* ConversationSummaries.ConversationSummaries;
    const forkDelta = (sourceThreadId: ThreadId, targetThreadId: ThreadId) =>
      handoffs.prepareForkDelta({
        sourceThreadId,
        targetThreadId,
        targetRunId: RunId.make("fork-target-run"),
        transferId: null,
        fromProviderThreadIds: [],
        toProviderThreadId: providerThread.id,
        fromProviderInstanceId: instanceId,
        toProviderInstanceId: instanceId,
        coveredRunOrdinals: { from: 1, to: 3 },
        deltaItems: [item(0)],
        createdAt: at,
      });
    // The summary cites message 1, which neither delta carries. The ordinals describe the fork
    // source, and a fork's history can span its ancestors, so they place nothing.
    for (const delta of [
      yield* forkDelta(threadId, ThreadId.make("fork-destination")),
      yield* forkDelta(ThreadId.make("fork-source"), threadId),
    ])
      assert.deepEqual(
        yield* service.forHandoff({
          projectId,
          handoffs: [yield* prepareHandoff(1), delta],
          itemIds: new Set([itemId(0)]),
        }),
        [],
      );
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect("does not admit later ancestor history through a portable fork handoff", () => {
  const model = citing();
  return Effect.gen(function* () {
    yield* seed;
    yield* persistSummary(0, [0, 1]);
    yield* seedRun(runId, 1);
    const laterAncestorRun = RunId.make("later-ancestor-run");
    yield* seedRun(laterAncestorRun, 3);
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const moved = messageEvent(1, rawText(1));
    if (moved.type === "message.updated")
      yield* projections.apply({
        ...moved,
        payload: { ...moved.payload, runId: laterAncestorRun },
      });
    yield* projections.apply({
      id: EventId.make("moved-ancestor-item"),
      type: "turn-item.updated",
      threadId,
      providerInstanceId: instanceId,
      occurredAt: at,
      payload: { ...item(1), runId: laterAncestorRun },
    });
    const sourceThread = ThreadId.make("portable-source");
    yield* projections.apply({
      id: EventId.make("portable-source-created"),
      type: "thread.created",
      threadId: sourceThread,
      providerInstanceId: instanceId,
      occurredAt: at,
      payload: {
        ...threadPayload,
        id: sourceThread,
        forkedFrom: { type: "run", threadId, runId },
      },
    });
    const sourceRun = RunId.make("portable-source-run");
    yield* seedRun(sourceRun, 3, sourceThread);
    for (const index of [20, 21])
      yield* projections.apply({
        id: EventId.make(`portable-source-item-${index}`),
        type: "turn-item.updated",
        threadId: sourceThread,
        providerInstanceId: instanceId,
        occurredAt: at,
        payload: {
          ...item(index),
          id: TurnItemId.make(`portable-source-item-${index}`),
          threadId: sourceThread,
          runId: sourceRun,
          text: "x".repeat(80_000),
        },
      });
    const source = yield* projections.getThreadRecords(sourceThread, ["runs", "attempts"]);
    const throughRun = source.runs.find((run) => run.id === sourceRun)!;
    const sourceItems = yield* ContextHandoffService.readForkHistoryItems(
      projections,
      source,
      throughRun,
    );
    assert.isFalse(sourceItems.some((entry) => entry.id === itemId(1)));
    const covered = ContextHandoffService.visibleDeltaRunOrdinals(source, sourceItems);
    assert.deepEqual(covered, { from: 3, to: 3 });
    const handoffs = yield* ContextHandoffService.ContextHandoffServiceV2;
    const portable = yield* handoffs.prepareProviderHandoff({
      threadId: ThreadId.make("portable-target"),
      targetRunId: RunId.make("portable-target-run"),
      transferId: null,
      fromProviderThreadIds: [],
      toProviderThreadId: providerThread.id,
      fromProviderInstanceId: instanceId,
      toProviderInstanceId: instanceId,
      coveredRunOrdinals: covered,
      strategy: "full_thread_summary",
      items: sourceItems,
      runs: source.runs,
      createdAt: at,
    });
    assert.deepEqual(
      [...new Set(portable.history!.messages.map((entry) => entry.threadId))],
      [threadId],
    );
    const service = yield* ConversationSummaries.ConversationSummaries;
    const offered = yield* service.forHandoff({
      projectId,
      handoffs: [portable],
      itemIds: new Set([itemId(0)]),
    });
    assert.deepEqual(
      offered,
      [],
      "ancestor run 3 happened after the source forked at ancestor run 1",
    );
  }).pipe(Effect.provide(makeLayer(model.generate, optedIn)));
});

it.effect("rolls up summaries written before migration 094 in conversation order", () => {
  const model = citing();
  return Effect.gen(function* () {
    yield* seedThread(14);
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const longText = "x".repeat(120_000);
    yield* projections.apply(messageEvent(0, longText));
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Digest.Digest;
    const sha256 = (text: string) =>
      crypto.digest(Digest.sha256, new TextEncoder().encode(text)).pipe(Effect.map(Hex.encode));
    const digest = yield* sha256(longText);
    // Before 094 the column held only the first source's time, which four leaves of one long
    // message share.
    yield* sql`DROP TABLE project_knowledge_views`;
    yield* sql`ALTER TABLE conversation_summaries RENAME COLUMN position TO first_source_at`;
    for (let index = 0; index < 4; index++) {
      const sources = Array.from({ length: 5 }, (_, part) => ({
        kind: "message" as const,
        threadId,
        messageId: messageId(0),
        digest,
        range: {
          start: (index * 5 + part) * 6_000,
          end: (index * 5 + part + 1) * 6_000,
          total: 120_000,
        },
      }));
      const summary: ConversationSummary = {
        ...scope,
        id: `summary:${yield* sha256(
          [
            "v2",
            threadId,
            ...sources.map((source) => `${conversationSummarySourceKey(source)}:${source.digest}`),
          ].join("\n"),
        )}`,
        sources,
        statements: [
          { text: `Range ${index}`, citations: [conversationSummarySourceKey(sources[0]!)] },
        ],
        modelSelection: { instanceId, model: "gpt-5" },
        createdAt: DateTime.formatIso(at),
      };
      yield* sql`
        INSERT INTO conversation_summaries (
          summary_id, project_id, thread_id, first_source_at, created_at, payload_json
        ) VALUES (
          ${summary.id}, ${projectId}, ${threadId}, ${DateTime.formatIso(at)},
          ${summary.createdAt}, ${yield* encodeSummary(summary)}
        )
      `;
    }
    // Later migrations are not rerunnable, so apply only the two this test undid.
    yield* Migration0094;
    yield* Migration0096;
    yield* summarize;
    assert.deepEqual(
      model.calls.find(isRollup)?.messages.map((message) => message.text),
      ["- Range 0", "- Range 1", "- Range 2", "- Range 3"],
    );
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
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
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
          position, created_at, payload_json
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
            }).pipe(
              Effect.map((history) => history.textByItem),
              Effect.provideService(ProjectKnowledge.ProjectKnowledge, knowledge),
            ),
          persist: (next) =>
            Effect.sync(() => {
              durable = next;
            }),
        });

      const delivery = yield* deliver(durable);
      yield* delivery.delivered;
      assert.deepEqual(delivery.summaryFactIds, [fact.id]);
      assert.include(delivery.context, `[Conversation summary ${summary.id}`);
      assert.include(delivery.context, "It is a summary, not the original evidence.");
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
      assert.deepEqual(retry.summaryFactIds, []);
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
      assert.deepEqual(afterForget.summaryFactIds, []);
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
