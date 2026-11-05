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
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
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
import {
  ConversationSummaryPassError,
  conversationSummaryEffects,
} from "./conversationSummarySchedule.ts";

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
      summary_id, project_id, thread_id, first_source_at, created_at, payload_json
    ) VALUES (
      ${summary.id}, ${projectId}, ${threadId},
      ${DateTime.formatIso(DateTime.add(at, { minutes: sourceIndexes[0]! }))},
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
    assert.isTrue(modern.sources.some((source) => source.ref.range !== undefined));
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

it.effect("records an unavailable model as a failed pass without publishing a summary", () => {
  const model = scripted(() =>
    Effect.fail(
      new TextGenerationError({ operation: "generateConversationSummary", detail: "No model" }),
    ),
  );
  return Effect.gen(function* () {
    yield* seed;
    assert.instanceOf(yield* summarize.pipe(Effect.flip), ConversationSummaryPassError);
    const result = yield* list;
    assert.deepEqual(result.summaries, []);
    assert.deepInclude(result.lastPass, {
      result: "failed",
      reason: "No model",
      waitingMessages: 10,
    });
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
      assert.isAbove(summaries.length, 3);
      const starts = summaries.map((summary) => summary.sources[0]!.range?.start ?? 0);
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
      assert.deepEqual(
        offers[0]!.summaryIds ?? [],
        summaries.map((summary) => summary.id),
      );
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
    assert.isTrue(replacement.sources.some((source) => source.range !== undefined));
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
