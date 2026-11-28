import * as HolographicMemory from "./HolographicMemory.ts";
import { deliveredKnowledgeForHistory, resolveKnowledgeComposer } from "./composer.ts";
import { readKnowledgeDeliveryState } from "./delivery.ts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { assert, it } from "@effect/vitest";
import {
  ComposerContextId,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectFactId,
  ProjectKnowledgeSearchResult,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  THREAD_SEARCH_QUERY_MAX_LENGTH,
  ThreadId,
  TurnItemId,
  type KnowledgeOrigin,
  type OrchestrationV2DomainEvent,
  type ProjectKnowledgeMutation,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as KnowledgeHandlers from "../../mcp/toolkits/knowledge/handlers.ts";
import { KnowledgeToolkit } from "../../mcp/toolkits/knowledge/tools.ts";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ThreadViewers from "../../orchestration-v2/ThreadViewers.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as TurnItemPositionStore from "../../orchestration-v2/TurnItemPositionStore.ts";
import { deliveryScrubEffect } from "./deliveryScrubSchedule.ts";
import * as ProjectionReplay from "../../orchestration-v2/testkit/ProjectionReplay.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectKnowledge from "./ProjectKnowledge.ts";

const decodeKnowledgeSearchResult = Schema.decodeUnknownEffect(ProjectKnowledgeSearchResult);
const decodeLegacyHistoryEvents = Schema.decodeEffect(
  Schema.Array(
    Schema.Literals([
      "baseline",
      "created",
      "edited",
      "confirmed",
      "forgotten",
      "feedback",
      "superseded",
    ]),
  ),
);

const environmentId = EnvironmentId.make("knowledge-test-environment");
const knowledgeTestLayer = (
  scoring: typeof HolographicMemory.layer = HolographicMemory.layer,
  noTranscriptSearch = false,
) =>
  ProjectKnowledge.layer.pipe(
    Layer.provide(scoring),
    Layer.provideMerge(
      Layer.mergeAll(
        ProjectStore.layer,
        ProjectionStore.layer,
        noTranscriptSearch
          ? Layer.mock(ThreadSearch.ThreadSearch)({
              search: () => Effect.die("Automatic recall must not search transcripts"),
            })
          : ThreadSearch.layer,
        ProjectionReplay.layer.pipe(
          Layer.provideMerge(EventStore.layer),
          Layer.provide(ProjectionStore.layer),
        ),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const layerTest = knowledgeTestLayer();
const receiptStores = Layer.mergeAll(
  EffectOutbox.layer,
  CommandReceiptStore.layer,
  TurnItemPositionStore.layer,
  EventStore.layer,
  ProjectStore.layer,
  ProjectionStore.layer.pipe(Layer.provide(NodeCrypto.layer)),
);
const receiptExecutor = Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
  execute: () => Effect.die("Unexpected effect"),
});
const receiptTestLayer = Layer.mergeAll(
  EventSink.layerFromStores.pipe(Layer.provide(ThreadViewers.layer)),
  EffectWorker.layer.pipe(Layer.provide(receiptExecutor)),
).pipe(
  Layer.provideMerge(receiptStores),
  Layer.provideMerge(ProjectKnowledge.layerDeliveryScrubber),
  Layer.provideMerge(layerTest),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 8, 27, 0, minute));

const createProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`created:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(at(0)),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot: `/work/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(at(0)),
        updatedAt: DateTime.formatIso(at(0)),
      },
    }),
  );

const thread = (
  threadId: ThreadId,
  projectId: ProjectId,
  overrides: { readonly archivedAt?: DateTime.Utc; readonly deletedAt?: DateTime.Utc } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`created:${threadId}`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: at(0),
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: overrides.archivedAt ?? null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: overrides.deletedAt ?? null,
  },
});

const message = (
  threadId: ThreadId,
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  options: { readonly minute?: number; readonly streaming?: boolean } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`message:${id}`),
  type: "message.updated",
  threadId,
  providerInstanceId,
  occurredAt: at(options.minute ?? 1),
  payload: {
    createdBy: role === "user" ? "user" : "agent",
    creationSource: role === "user" ? "web" : "provider",
    id: MessageId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: options.streaming ?? false,
    createdAt: at(options.minute ?? 1),
    updatedAt: at(options.minute ?? 1),
  },
});

const attachedComposer = (outcome: ProjectKnowledge.RecallOutcome) =>
  outcome._tag === "Attached" ? outcome.composer : null;

const attachedFactIds = (outcome: ProjectKnowledge.RecallOutcome) => {
  const composer = attachedComposer(outcome);
  return (composer?.records ?? []).flatMap((record) =>
    record.kind === "project-knowledge" && "knowledge" in record
      ? record.knowledge.selections.flatMap((selection) =>
          selection.kind === "fact" ? [selection.factId] : [],
        )
      : [],
  );
};

const createFact = (projectId: ProjectId, id = "fact-one") =>
  ({
    action: "create",
    commandId: CommandId.make(`create:${id}`),
    projectId,
    factId: ProjectFactId.make(id),
    content: "Cache keys include tenant IDs.",
    entities: ["cache", "tenant"],
    tags: ["isolation"],
    kind: "decision",
    sources: [{ kind: "user" }],
  }) satisfies ProjectKnowledgeMutation;

it.effect("renders user attribution once in prepared and provider fact headers", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projectId = ProjectId.make("user-attribution");
    yield* createProject(projectId);
    const fact = yield* knowledge.mutate(createFact(projectId), { kind: "user" });
    const context = {
      environmentId,
      projectId,
      selections: [{ kind: "fact" as const, factId: fact.id, revision: fact.revision }],
      maxBytes: 48000,
    };
    const prepared = yield* knowledge.prepareContext(context);
    const record = {
      version: 1 as const,
      kind: "project-knowledge" as const,
      contextId: ComposerContextId.make("assertion-context"),
      label: "User fact",
      knowledge: context,
    };
    const delivered = yield* resolveKnowledgeComposer({
      projectId,
      text: formatComposerContextReference(record),
      records: [record],
    });
    for (const text of [prepared.text, delivered.text]) {
      const header = text.match(/\[Fact [^\n]+\]/)?.[0];
      assert.isDefined(header);
      assert.equal(header?.match(/User assertion/g)?.length, 1);
      assert.include(header!, "revision:1 status:saved trust:0.5; User assertion]");
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("persists edits with CAS, erases forgotten content and cannot resurrect on retries", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("facts");
    yield* createProject(projectId);
    const command = createFact(projectId);
    const saved = yield* knowledge.mutate(command, { kind: "user" });
    assert.equal(saved.revision, 1);
    assert.equal(saved.status, "saved");
    const oversized = yield* knowledge
      .mutate(
        { ...createFact(projectId, "oversized"), content: "測".repeat(6000) },
        { kind: "user" },
      )
      .pipe(Effect.result);
    assert.equal(Result.isFailure(oversized) && oversized.failure.reason, "fact_size");
    assert.deepEqual((yield* knowledge.list({ projectId })).facts, [saved]);
    const edits = yield* Effect.forEach(
      ["region", "account"],
      (entity) =>
        knowledge
          .mutate(
            {
              action: "edit",
              commandId: CommandId.make(`edit:${entity}`),
              projectId,
              factId: saved.id,
              expectedRevision: 1,
              content: `Cache keys include ${entity} IDs.`,
              entities: [entity],
              tags: [],
              kind: "decision",
              sources: [{ kind: "user" }],
            },
            { kind: "user" },
          )
          .pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    assert.equal(edits.filter(Result.isSuccess).length, 1);
    const rejection = edits.find(Result.isFailure);
    assert.equal(rejection?.failure.reason, "conflict");
    const current = (yield* knowledge.list({ projectId })).facts[0]!;
    const forgotten = yield* knowledge.mutate(
      {
        action: "forget",
        commandId: CommandId.make("forget"),
        projectId,
        factId: current.id,
        expectedRevision: 2,
      },
      { kind: "user" },
    );
    assert.equal(forgotten.status, "forgotten");
    assert.equal(forgotten.content, null);
    assert.deepEqual(forgotten.sources, []);
    assert.deepEqual(forgotten.entities, []);
    assert.deepEqual(forgotten.tags, []);
    assert.deepEqual((yield* knowledge.list({ projectId })).facts, []);
    assert.deepEqual(yield* knowledge.mutate(command, { kind: "user" }), forgotten);
    const recreate = yield* knowledge
      .mutate({ ...command, commandId: CommandId.make("recreate") }, { kind: "user" })
      .pipe(Effect.result);
    assert.equal(Result.isFailure(recreate) && recreate.failure.reason, "forgotten");
    const fts =
      yield* sql`SELECT rowid FROM project_knowledge_fts WHERE project_knowledge_fts MATCH 'cache OR region OR account'`;
    assert.deepEqual(fts, []);
    const stored = yield* sql<{
      content: string | null;
      entities_json: string;
      tags_json: string;
      sources_json: string;
    }>`SELECT content, entities_json, tags_json, sources_json FROM project_knowledge_facts`;
    assert.deepEqual(stored, [
      { content: null, entities_json: "[]", tags_json: "[]", sources_json: "[]" },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("saves agent facts for immediate recall and rehydrates exact sources", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectId = ProjectId.make("sourced");
    const threadId = ThreadId.make("source-thread");
    const messageId = MessageId.make("source-message");
    yield* createProject(projectId);
    yield* projections.apply(thread(threadId, projectId));
    yield* projections.apply(
      message(threadId, messageId, "user", "Use tenant IDs in every cache key."),
    );
    const recalled = yield* knowledge.search({
      projectId,
      query: "tenant IDs",
      requestId: CommandId.make("recall-source"),
    });
    assert.equal(recalled.messages.matches[0]?.messageId, messageId);
    const source = yield* knowledge.readSource({
      projectId,
      threadId,
      messageId,
      ...(recalled.messages.matches[0]?.digest === undefined
        ? {}
        : { digest: recalled.messages.matches[0].digest }),
    });
    assert.equal(source.state, "available");
    if (source.state !== "available") return;
    const peerId = MessageId.make("peer-message");
    yield* projections.apply(message(threadId, peerId, "assistant", "Use Postgres for sessions."));
    yield* projections.apply({
      id: EventId.make("peer-item"),
      type: "turn-item.updated",
      threadId,
      providerInstanceId,
      occurredAt: at(2),
      payload: {
        id: TurnItemId.make("peer-item"),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: at(2),
        completedAt: at(2),
        updatedAt: at(2),
        type: "assistant_message",
        messageId: peerId,
        text: "Use Postgres for sessions.",
        streaming: false,
        speaker: { label: "Astra", model: "gpt-6-astra" },
      },
    });
    const peer = yield* knowledge.readSource({ projectId, threadId, messageId: peerId });
    assert.deepEqual(peer.state === "available" && [peer.role, peer.speaker], [
      "assistant",
      { label: "Astra", model: "gpt-6-astra" },
    ]);
    const saved = yield* knowledge.mutate(
      { ...createFact(projectId), sources: [source.source] },
      { kind: "agent-client", sessionId: "test-agent", label: "Test agent" },
    );
    assert.equal(saved.status, "saved");
    assert.deepEqual(
      (yield* knowledge.list({ projectId })).facts.map((fact) => fact.id),
      [saved.id],
    );
    const context = {
      environmentId,
      projectId,
      selections: [{ kind: "fact" as const, factId: saved.id, revision: 1 }],
      maxBytes: 4096,
    };
    const preview = yield* knowledge.prepareContext(context);
    assert.include(preview.text, "status:saved");
    assert.include(preview.text, "Cache keys include tenant IDs.");
    assert.include(preview.text, `Message ${threadId}/${messageId}`);
    assert.isAtLeast(preview.byteLength, Buffer.byteLength(preview.text));
    assert.include(
      (yield* knowledge.resolveForTurn(preview.context)).text,
      "Cache keys include tenant IDs.",
    );
    yield* projections.apply(
      message(threadId, messageId, "user", "Use tenant IDs and regions.", { minute: 4 }),
    );
    const staleSource = yield* knowledge.readSource({ projectId, ...source.source });
    assert.deepEqual(staleSource, { state: "unavailable", reason: "changed" });
    const stale = yield* knowledge.resolveForTurn(preview.context).pipe(Effect.result);
    assert.equal(Result.isFailure(stale) && stale.failure.reason, "stale_context");
    const records = yield* projections.getThreadRecords(threadId, []);
    yield* projections.apply({
      id: EventId.make("delete-source"),
      threadId,
      type: "thread.deleted",
      occurredAt: at(5),
      payload: { ...records.thread, deletedAt: at(5) },
    });
    assert.deepEqual(yield* knowledge.readSource({ projectId, threadId, messageId }), {
      state: "unavailable",
      reason: "deleted",
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("lists which facts cite sources that were edited, deleted or archived", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectId = ProjectId.make("badges");
    yield* createProject(projectId);
    const cite = Effect.fn("test.cite")(function* (key: string) {
      const threadId = ThreadId.make(`${key}-thread`);
      const messageId = MessageId.make(`${key}-message`);
      yield* projections.apply(thread(threadId, projectId));
      yield* projections.apply(message(threadId, messageId, "assistant", `${key} decision`));
      const source = yield* knowledge.readSource({ projectId, threadId, messageId });
      assert.equal(source.state, "available");
      if (source.state !== "available") return yield* Effect.die("source unavailable");
      yield* knowledge.mutate(
        {
          ...createFact(projectId, key),
          commandId: CommandId.make(`create:${key}`),
          sources: [source.source],
        },
        { kind: "user" },
      );
      return { threadId, messageId };
    });
    yield* cite("intact");
    const edited = yield* cite("edited");
    const deleted = yield* cite("deleted");
    const archived = yield* cite("archived");
    yield* knowledge.mutate(createFact(projectId, "asserted"), { kind: "user" });

    yield* projections.apply(
      message(edited.threadId, edited.messageId, "assistant", "edited later", { minute: 3 }),
    );
    const deletedThread = yield* projections.getThreadRecords(deleted.threadId, []);
    yield* projections.apply({
      id: EventId.make("delete-badge-source"),
      threadId: deleted.threadId,
      type: "thread.deleted",
      occurredAt: at(4),
      payload: { ...deletedThread.thread, deletedAt: at(4) },
    });
    const archivedThread = yield* projections.getThreadRecords(archived.threadId, []);
    yield* projections.apply({
      id: EventId.make("archive-badge-source"),
      threadId: archived.threadId,
      type: "thread.archived",
      occurredAt: at(5),
      payload: { ...archivedThread.thread, archivedAt: at(5) },
    });

    const listed = yield* knowledge.list({ projectId });
    assert.equal(listed.facts.length, 5);
    assert.sameDeepMembers(
      [...(listed.unavailableSources ?? [])],
      [
        { factId: ProjectFactId.make("edited"), reason: "changed" },
        { factId: ProjectFactId.make("deleted"), reason: "deleted" },
        { factId: ProjectFactId.make("archived"), reason: "archived" },
      ],
    );
    // The badge must agree with what opening the citation reports.
    for (const [key, ref, reason] of [
      ["edited", edited, "changed"],
      ["deleted", deleted, "deleted"],
      ["archived", archived, "archived"],
    ] as const) {
      const source = listed.facts.find((item) => item.id === key)?.sources[0];
      assert.equal(source?.kind, "message");
      if (source?.kind !== "message") continue;
      assert.deepEqual(yield* knowledge.readSource({ projectId, ...ref, digest: source.digest }), {
        state: "unavailable",
        reason,
      });
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "isolates projects and environments, honors archives and bounds UTF-8 context bytes",
  () =>
    Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const projectId = ProjectId.make("scope-a");
      const other = ProjectId.make("scope-b");
      yield* createProject(projectId);
      yield* createProject(other);
      const threadId = ThreadId.make("archive-thread");
      const messageId = MessageId.make("archive-message");
      yield* projections.apply(thread(threadId, projectId, { archivedAt: at(2) }));
      yield* projections.apply(message(threadId, messageId, "assistant", "界".repeat(200)));
      assert.deepEqual(yield* knowledge.readSource({ projectId: other, threadId, messageId }), {
        state: "unavailable",
        reason: "wrong_project",
      });
      assert.deepEqual(yield* knowledge.readSource({ projectId, threadId, messageId }), {
        state: "unavailable",
        reason: "archived",
      });
      const source = yield* knowledge.readSource({
        projectId,
        threadId,
        messageId,
        includeArchived: true,
      });
      if (source.state !== "available")
        return assert.fail("Archived message must be readable explicitly");
      const context = {
        environmentId,
        projectId,
        selections: [source.source],
        includeArchived: true,
        maxBytes: 48000,
      };
      const preview = yield* knowledge.prepareContext(context);
      assert.deepEqual(preview.items, [{ label: `Message ${messageId}`, text: source.text }]);
      assert.isAbove(preview.byteLength, preview.text.length);
      const budget = yield* knowledge
        .prepareContext({ ...context, maxBytes: preview.byteLength - 1 })
        .pipe(Effect.result);
      assert.equal(Result.isFailure(budget) && budget.failure.reason, "context_budget");
      const wrongEnvironment = yield* knowledge
        .resolveForTurn({ ...context, environmentId: EnvironmentId.make("other") })
        .pipe(Effect.result);
      assert.equal(
        Result.isFailure(wrongEnvironment) && wrongEnvironment.failure.reason,
        "wrong_environment",
      );
      const fact = yield* knowledge.mutate(createFact(projectId), { kind: "user" });
      assert.deepEqual((yield* knowledge.list({ projectId: other })).facts, []);
      const feedback = {
        action: "feedback" as const,
        commandId: CommandId.make("helpful"),
        projectId,
        factId: fact.id,
        expectedRevision: 1,
        helpful: true,
      };
      const boosted = yield* knowledge.mutate(feedback, { kind: "user" });
      assert.equal(boosted.trust, 0.55);
      assert.deepEqual(yield* knowledge.mutate(feedback, { kind: "user" }), boosted);
      const reuse = yield* knowledge
        .mutate({ ...feedback, helpful: false }, { kind: "user" })
        .pipe(Effect.result);
      assert.equal(Result.isFailure(reuse) && reuse.failure.reason, "command_reused");
      const agentAssertion = yield* knowledge
        .mutate(createFact(projectId, "agent-assertion"), {
          kind: "agent-client",
          sessionId: "test-agent",
          label: "Test agent",
        })
        .pipe(Effect.result);
      assert.equal(
        Result.isFailure(agentAssertion) && agentAssertion.failure.reason,
        "invalid_source",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["agent", "linked-agent", "notification"] as const)(
  "invalidates unattributed sources and preserves identity when they are re-read: %s",
  (sourceKind) =>
    Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const projectId = ProjectId.make("source-provenance");
      const threadId = ThreadId.make("source-receiver");
      const messageId = MessageId.make("source-agent-message");
      const text = "Cache keys include tenant IDs.";
      yield* createProject(projectId);
      yield* projections.apply(thread(threadId, projectId));
      yield* projections.apply(message(threadId, messageId, "user", text));
      const legacy = yield* knowledge.readSource({ projectId, threadId, messageId });
      if (legacy.state !== "available") return assert.fail("The source should exist");
      const fact = yield* knowledge.mutate(
        { ...createFact(projectId), sources: [legacy.source] },
        { kind: "agent-client", sessionId: "test-agent", label: "Test agent" },
      );
      const records = yield* projections.getThreadRecords(threadId, ["messages"]);
      const provenance =
        sourceKind === "agent"
          ? {
              createdBy: "agent" as const,
              creationSource: "mcp" as const,
              senderThreadId: ThreadId.make("coordinator"),
            }
          : sourceKind === "linked-agent"
            ? {
                createdBy: "agent" as const,
                creationSource: "mcp" as const,
                linkedSender: {
                  environmentId: EnvironmentId.make("other-environment"),
                  threadId: ThreadId.make("coordinator"),
                  title: "Lab coordinator",
                },
              }
            : { createdBy: "system" as const, creationSource: "server" as const };
      yield* projections.apply({
        id: EventId.make("source-attribution"),
        type: "message.updated",
        threadId,
        providerInstanceId,
        occurredAt: at(2),
        payload: {
          ...records.messages[0]!,
          ...provenance,
          createdBy: "user",
          ...(sourceKind === "notification"
            ? {
                notification: {
                  source: { kind: "system" as const },
                  outcome: "updated" as const,
                  summary: text,
                },
              }
            : {}),
        },
      });
      assert.deepEqual(yield* knowledge.readSource({ projectId, ...legacy.source }), {
        state: "unavailable",
        reason: "changed",
      });
      assert.deepEqual((yield* knowledge.list({ projectId })).unavailableSources, [
        { factId: fact.id, reason: "changed" },
      ]);
      const search = yield* knowledge.search({
        projectId,
        query: "tenant IDs",
        requestId: CommandId.make("provenance-search"),
      });
      const hit = search.messages.matches[0]!;
      if (hit.digest === undefined) return assert.fail("Search must return a source digest");
      assert.deepEqual(hit.provenance, provenance);
      const threadSearch = yield* ThreadSearch.ThreadSearch;
      assert.deepEqual(
        (yield* threadSearch.search({ query: "tenant IDs" })).matches[0]?.provenance,
        provenance,
      );
      const source = yield* knowledge.readSource({
        projectId,
        threadId,
        messageId,
        digest: hit.digest,
      });
      if (source.state !== "available")
        return assert.fail("The current search digest must resolve");
      assert.deepEqual(source.provenance, provenance);
      assert.equal(source.text, text);
      assert.notEqual(source.source.digest, legacy.source.digest);
      const context = yield* knowledge.prepareContext({
        environmentId,
        projectId,
        selections: [source.source],
        maxBytes: 4096,
      });
      assert.include(context.text, sourceKind === "notification" ? "system event" : "coordinator");
      assert.include(context.text, text);
      const stale = yield* knowledge
        .prepareContext({
          environmentId,
          projectId,
          selections: [{ kind: "fact", factId: fact.id, revision: fact.revision }],
          maxBytes: 4096,
        })
        .pipe(Effect.result);
      assert.equal(Result.isFailure(stale) && stale.failure.reason, "stale_context");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("MCP rejects unauthorized mutations and saves authorized facts directly", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectId = ProjectId.make("mcp-project");
    const threadId = ThreadId.make("mcp-source");
    const messageId = MessageId.make("mcp-message");
    yield* createProject(projectId);
    yield* projections.apply(thread(threadId, projectId));
    yield* projections.apply(
      message(threadId, messageId, "user", "Project cache requires tenant isolation."),
    );
    const source = yield* knowledge.readSource({ projectId, threadId, messageId });
    if (source.state !== "available") return assert.fail("Expected canonical source");
    const cited = { ...createFact(projectId), sources: [source.source] };
    const invoke = Effect.fn("test.knowledgeMcp")(function* (
      input: ProjectKnowledgeMutation,
      access: "read-only" | "full-access",
      authorized = true,
    ) {
      const dependencies = Layer.mergeAll(
        Layer.succeed(ProjectKnowledge.ProjectKnowledge, knowledge),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "knowledge-test-client",
          thread: undefined,
          client: { sessionId: "test-client", label: "Test client", access },
          issuedAt: 0,
          capabilities: new Set(authorized ? ["orchestration" as const] : []),
        }),
      );
      const toolkit = yield* KnowledgeToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(KnowledgeHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const results = yield* toolkit
        .handle("t3_knowledge_mutate", { mutation: input })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      return results.at(-1)?.result;
    });
    assert.deepInclude(yield* invoke(cited, "read-only"), { code: "capability_denied" });
    assert.deepInclude(yield* invoke(cited, "full-access", false), {
      code: "capability_denied",
    });
    assert.deepEqual((yield* knowledge.list({ projectId, status: "saved" })).facts, []);
    assert.deepInclude(yield* invoke(cited, "full-access"), { status: "saved", revision: 1 });
    const observation = { ...createFact(projectId, "agent-observation"), sources: [] };
    const created = yield* invoke(observation, "full-access");
    assert.deepInclude(created, {
      status: "saved",
      origin: { kind: "agent-client", sessionId: "test-client", label: "Test client" },
      sources: [],
    });
    const recalled = yield* knowledge.search({
      projectId,
      query: "tenant cache",
      requestId: CommandId.make("agent-observation-recall"),
    });
    assert.isTrue(
      recalled.facts.state === "available" &&
        recalled.facts.matches.some(
          (match) => match.fact.id === observation.factId && match.fact.status === "saved",
        ),
    );
    const edited = yield* invoke(
      {
        ...observation,
        action: "edit",
        commandId: CommandId.make("edit-observation"),
        expectedRevision: 1,
        content: "Tenant cache observations are scoped.",
      },
      "full-access",
    );
    assert.deepInclude(edited, {
      revision: 2,
      origin: { kind: "agent-client", sessionId: "test-client", label: "Test client" },
    });
    assert.deepInclude(
      yield* invoke(
        {
          action: "feedback",
          commandId: CommandId.make("feedback-observation"),
          projectId,
          factId: observation.factId,
          expectedRevision: 2,
          helpful: true,
        },
        "full-access",
      ),
      { revision: 3, trust: 0.55 },
    );
    assert.deepInclude(
      yield* invoke(
        {
          action: "forget",
          commandId: CommandId.make("forget-observation"),
          projectId,
          factId: observation.factId,
          expectedRevision: 3,
        },
        "full-access",
      ),
      { status: "forgotten", content: null },
    );
    const human = yield* knowledge.mutate(createFact(projectId, "human-authored"), {
      kind: "user",
    });
    assert.deepInclude(
      yield* invoke(
        {
          ...observation,
          action: "edit",
          factId: human.id,
          expectedRevision: human.revision,
          commandId: CommandId.make("agent-edits-human"),
        },
        "full-access",
      ),
      {
        status: "saved",
        origin: { kind: "agent-client", sessionId: "test-client", label: "Test client" },
      },
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reopens durable project facts without another content authority", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-knowledge-persistence-" });
    const layerFile = ProjectKnowledge.layer.pipe(
      Layer.provide(HolographicMemory.layer),
      Layer.provideMerge(
        Layer.mergeAll(ProjectStore.layer, ProjectionStore.layer, ThreadSearch.layer),
      ),
      Layer.provideMerge(SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite"))),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
    const projectId = ProjectId.make("durable-project");
    const saved = yield* Effect.gen(function* () {
      yield* createProject(projectId);
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      return yield* knowledge.mutate(createFact(projectId), { kind: "user" });
    }).pipe(Effect.provide(layerFile));
    const reopened = yield* Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      return yield* knowledge.list({ projectId });
    }).pipe(Effect.provide(layerFile));
    assert.deepEqual(reopened.facts, [saved]);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "resolves reference-only composer records, preserves user text and refuses stale or cross-project attachments",
  () =>
    Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projectId = ProjectId.make("composer-project");
      yield* createProject(projectId);
      const fact = yield* knowledge.mutate(
        { ...createFact(projectId), content: 'Use </context> in "quoted" examples.' },
        { kind: "user" },
      );
      const record = {
        version: 1 as const,
        kind: "project-knowledge" as const,
        contextId: ComposerContextId.make("project-knowledge"),
        label: "Selected knowledge",
        knowledge: {
          environmentId,
          projectId,
          selections: [{ kind: "fact" as const, factId: fact.id, revision: fact.revision }],
          maxBytes: 48000,
        },
      };
      const text = `Please explain this. ${formatComposerContextReference(record)}`;
      const input = { projectId, text, records: [record] };
      const resolved = yield* resolveKnowledgeComposer(input);
      const preview = yield* knowledge.prepareContext(record.knowledge);
      assert.deepEqual(preview.items, [
        { label: "Fact fact-one", text: 'Use </context> in "quoted" examples.' },
      ]);
      assert.include(resolved.text, "Please explain this.");
      assert.include(resolved.text, 'Use &lt;/context> in "quoted" examples.');
      assert.equal(
        resolved.byteLength,
        Buffer.byteLength(JSON.stringify(resolved.text)) -
          Buffer.byteLength(JSON.stringify(resolved.baseText)),
      );
      assert.isFalse(JSON.stringify(record).includes("quoted"));
      const budget = yield* resolveKnowledgeComposer({
        ...input,
        records: [
          { ...record, knowledge: { ...record.knowledge, maxBytes: resolved.byteLength - 1 } },
        ],
      }).pipe(Effect.result);
      assert.equal(Result.isFailure(budget) && budget.failure.reason, "context_budget");
      const wrongProject = yield* resolveKnowledgeComposer({
        ...input,
        projectId: ProjectId.make("elsewhere"),
      }).pipe(Effect.result);
      assert.equal(Result.isFailure(wrongProject) && wrongProject.failure.reason, "wrong_project");
      yield* knowledge.mutate(
        {
          action: "forget",
          commandId: CommandId.make("forget-composer"),
          projectId,
          factId: fact.id,
          expectedRevision: fact.revision,
        },
        { kind: "user" },
      );
      const stale = yield* resolveKnowledgeComposer(input).pipe(Effect.result);
      assert.equal(Result.isFailure(stale) && stale.failure.reason, "stale_context");
      assert.deepEqual(yield* resolveKnowledgeComposer({ ...input, text: "Plain chat" }), {
        text: "Plain chat",
        baseText: "Plain chat",
        byteLength: 0,
        items: [],
        omissions: [{ contextId: record.contextId, label: record.label, reason: "not_referenced" }],
      });
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "keeps the as-sent snapshot through edits, retries and failover, and scrubs it on forget",
  () =>
    Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projectId = ProjectId.make("delivery-project");
      yield* createProject(projectId);
      const fact = yield* knowledge.mutate(createFact(projectId), { kind: "user" });
      const record = {
        version: 1 as const,
        kind: "project-knowledge" as const,
        contextId: ComposerContextId.make("delivered-knowledge"),
        label: "Delivered knowledge",
        knowledge: {
          environmentId,
          projectId,
          selections: [{ kind: "fact" as const, factId: fact.id, revision: fact.revision }],
          maxBytes: 48000,
        },
      };
      const composer = yield* resolveKnowledgeComposer({
        projectId,
        text: `Use this. ${formatComposerContextReference(record)}`,
        records: [record],
      });
      const [item] = composer.items;
      assert.include(item?.text, "Cache keys include tenant IDs.");
      const threadId = ThreadId.make("delivery-thread");
      const messageId = MessageId.make("delivery-message");
      const delivery = (attemptId: string, status: "prepared" | "sent", minute: number) => ({
        attemptId: RunAttemptId.make(attemptId),
        runId: RunId.make("delivery-run"),
        threadId,
        messageId,
        projectId,
        providerInstanceId,
        status,
        items: composer.items,
        omissions: composer.omissions,
        createdAt: DateTime.formatIso(at(minute)),
        updatedAt: DateTime.formatIso(at(minute)),
      });
      const read = knowledge.readDeliveries({ projectId, threadId, messageId });
      yield* knowledge.recordDelivery(delivery("attempt-1", "prepared", 1));
      yield* knowledge.recordDelivery(delivery("attempt-1", "sent", 2));
      const sent = yield* read;
      assert.deepEqual(
        sent.deliveries.map((entry) => [entry.attemptId, entry.status, entry.createdAt]),
        [["attempt-1", "sent", DateTime.formatIso(at(1))]],
      );
      assert.deepEqual(sent.deliveries[0]?.items, [{ ...item!, current: "current" }]);

      yield* knowledge.mutate(
        {
          ...createFact(projectId),
          action: "edit",
          commandId: CommandId.make("edit-after-send"),
          expectedRevision: fact.revision,
          content: "Cache keys include region IDs.",
        },
        { kind: "user" },
      );
      // Re-preparing a sent attempt must neither duplicate nor rewrite what was sent.
      yield* knowledge.recordDelivery({
        ...delivery("attempt-1", "prepared", 3),
        items: [{ ...item!, text: "rewritten" }],
      });
      const edited = yield* read;
      assert.equal(edited.deliveries.length, 1);
      assert.equal(edited.deliveries[0]?.status, "sent");
      assert.equal(edited.deliveries[0]?.items[0]?.text, item?.text);
      assert.equal(edited.deliveries[0]?.items[0]?.current, "changed");

      yield* knowledge.recordDelivery(delivery("attempt-failover", "sent", 4));
      // Handoffs replay the sent copy of an edited fact; unsent attempts add nothing.
      yield* knowledge.recordDelivery({
        ...delivery("attempt-unsent", "prepared", 5),
        runId: RunId.make("delivery-run-unsent"),
        messageId: MessageId.make("delivery-message-unsent"),
      });
      const historical = (id: string, runId: string) => ({
        itemId: TurnItemId.make(id),
        role: "user" as const,
        kind: "user_message",
        text: "Use this.",
        threadId,
        runId: RunId.make(runId),
        providerThreadId: null,
        status: "completed",
      });
      const handoff = deliveredKnowledgeForHistory({
        projectId,
        messages: [
          historical("item:sent", "delivery-run"),
          historical("item:unsent", "delivery-run-unsent"),
        ],
        userItemId: (id) => (id === messageId ? "item:sent" : "item:unsent"),
      });
      const evidence = yield* handoff;
      assert.deepEqual([...evidence.textByItem.keys()], ["item:sent"]);
      assert.include(evidence.textByItem.get("item:sent"), "Cache keys include tenant IDs.");
      assert.notInclude(evidence.textByItem.get("item:sent"), "region IDs");
      assert.deepEqual([...evidence.factIdsByItem], [["item:sent", [fact.id]]]);

      yield* knowledge.mutate(
        {
          action: "forget",
          commandId: CommandId.make("forget-after-send"),
          projectId,
          factId: fact.id,
          expectedRevision: fact.revision + 1,
        },
        { kind: "user" },
      );
      // Forgetting removes the as-sent excerpt but keeps the record of what was selected.
      const forgotten = yield* read;
      assert.deepEqual(
        forgotten.deliveries.map((entry) => [
          entry.attemptId,
          entry.status,
          entry.items[0]?.text,
          entry.items[0]?.contentRemoved,
          entry.items[0]?.current,
          entry.items[0]?.context.selections,
        ]),
        [
          ["attempt-1", "sent", "", true, "forgotten", item?.context.selections],
          ["attempt-failover", "sent", "", true, "forgotten", item?.context.selections],
        ],
      );
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(
        yield* sql`SELECT attempt_id FROM project_knowledge_deliveries WHERE items_json LIKE '%tenant IDs%'`,
        [],
      );
      // A handoff after the forget carries nothing for it.
      const afterForget = yield* handoff;
      assert.deepEqual([...afterForget.textByItem.keys()], []);
      assert.deepEqual([...afterForget.factIdsByItem], []);
      const otherProjectId = ProjectId.make("other-delivery-project");
      yield* createProject(otherProjectId);
      assert.deepEqual(
        yield* knowledge.readDeliveries({ projectId: otherProjectId, threadId, messageId }),
        { deliveries: [] },
      );
    }).pipe(Effect.provide(layerTest)),
);

const composeDelivery = Effect.fn("test.composeDelivery")(function* (
  projectId: ProjectId,
  key: string,
  factId = key,
) {
  const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
  const fact = yield* knowledge.mutate(createFact(projectId, factId), { kind: "user" });
  const record = {
    version: 1 as const,
    kind: "project-knowledge" as const,
    contextId: ComposerContextId.make(`${key}-context`),
    label: key,
    knowledge: {
      environmentId,
      projectId,
      selections: [{ kind: "fact" as const, factId: fact.id, revision: fact.revision }],
      maxBytes: 48000,
    },
  };
  const composer = yield* resolveKnowledgeComposer({
    projectId,
    text: `Use this. ${formatComposerContextReference(record)}`,
    records: [record],
  });
  const threadId = ThreadId.make(`${key}-thread`);
  const messageId = MessageId.make(`${key}-message`);
  const delivery = (attemptId: string, status: "prepared" | "sent", minute: number) => ({
    attemptId: RunAttemptId.make(attemptId),
    runId: RunId.make(`${key}-run`),
    threadId,
    messageId,
    projectId,
    providerInstanceId,
    status,
    items: composer.items,
    omissions: composer.omissions,
    createdAt: DateTime.formatIso(at(minute)),
    updatedAt: DateTime.formatIso(at(minute)),
  });
  const forget = knowledge.mutate(
    {
      action: "forget",
      commandId: CommandId.make(`forget:${key}`),
      projectId,
      factId: fact.id,
      expectedRevision: fact.revision,
    },
    { kind: "user" },
  );
  const excerpts = knowledge
    .readDeliveries({ projectId, threadId, messageId })
    .pipe(
      Effect.map((read) =>
        read.deliveries.map((entry) => [
          entry.attemptId,
          entry.status,
          entry.items[0]?.text,
          entry.items[0]?.contentRemoved,
        ]),
      ),
    );
  return { delivery, forget, excerpts, byteLength: composer.byteLength };
});

it.effect("keeps each steering message's receipt and forgets only its own evidence", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projectId = ProjectId.make("steering-deliveries");
    yield* createProject(projectId);
    const first = yield* composeDelivery(projectId, "first-steer");
    const second = yield* composeDelivery(projectId, "second-steer");
    const original = first.delivery("shared-attempt", "sent", 1);
    const followup = {
      ...second.delivery("shared-attempt", "prepared", 2),
      threadId: original.threadId,
      runId: original.runId,
    };
    yield* knowledge.recordDelivery(original);
    yield* knowledge.recordDelivery(followup);
    yield* knowledge.recordDelivery({ ...followup, status: "sent" });
    yield* knowledge.recordDelivery({
      ...followup,
      items: followup.items.map((item) => ({ ...item, text: "must not replace sent evidence" })),
    });
    const readSecond = knowledge.readDeliveries(followup);
    assert.equal((yield* readSecond).deliveries[0]?.items[0]?.text, followup.items[0]?.text);
    assert.equal((yield* first.excerpts)[0]?.[1], "sent");

    const evidence = yield* deliveredKnowledgeForHistory({
      projectId,
      messages: [original, followup].map((receipt) => ({
        itemId: TurnItemId.make(`item:${receipt.messageId}`),
        role: "user" as const,
        kind: "user_message",
        text: "Use the attached decision.",
        threadId: receipt.threadId,
        runId: receipt.runId,
        providerThreadId: null,
        status: "completed",
      })),
      userItemId: (id) => `item:${id}`,
    });
    assert.equal(evidence.textByItem.size, 2);
    yield* knowledge.recordViews(
      projectId,
      ThreadId.make("steering-replay"),
      evidence.factIdsByItem.get(`item:${original.messageId}`) ?? [],
    );
    const sql = yield* SqlClient.SqlClient;
    const viewed = yield* sql<{ readonly fact_id: string }>`
      SELECT fact_id FROM project_knowledge_views
      WHERE project_id = ${projectId} AND thread_id = 'steering-replay'
    `;
    assert.sameMembers(
      viewed.map((row) => row.fact_id),
      original.items.flatMap((item) =>
        item.context.selections.flatMap((selection) =>
          selection.kind === "fact" ? [selection.factId] : [],
        ),
      ),
    );
    yield* first.forget;
    assert.equal((yield* first.excerpts)[0]?.[2], "");
    assert.equal((yield* readSecond).deliveries[0]?.items[0]?.text, followup.items[0]?.text);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("checks delivery state beyond the evidence inspector's twenty-receipt page", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projectId = ProjectId.make("delivery-state-pagination");
    yield* createProject(projectId);
    const receipt = {
      projectId,
      threadId: ThreadId.make("delivery-state-thread"),
      messageId: MessageId.make("delivery-state-message"),
      runId: RunId.make("delivery-state-run"),
      attemptId: RunAttemptId.make("current-attempt"),
      providerInstanceId,
      providerThreadId: ProviderThreadId.make("delivery-state-provider-thread"),
      nativeThreadId: "original-native",
      status: "uncertain" as const,
      items: [],
      omissions: [],
      createdAt: DateTime.formatIso(at(30)),
      updatedAt: DateTime.formatIso(at(30)),
    };
    for (let index = 0; index < 25; index++)
      yield* knowledge.recordDelivery({
        ...receipt,
        attemptId: RunAttemptId.make(`older-attempt-${index}`),
        status: "failed",
        createdAt: DateTime.formatIso(at(index)),
        updatedAt: DateTime.formatIso(at(index)),
      });
    yield* knowledge.recordDelivery(receipt);
    assert.lengthOf((yield* knowledge.readDeliveries(receipt)).deliveries, 20);
    assert.deepEqual(yield* readKnowledgeDeliveryState(receipt), {
      sent: false,
      sentThisAttempt: false,
      uncertain: true,
    });
    yield* knowledge.recordDelivery({ ...receipt, status: "sent" });
    // Receipt safety must not depend on decoding/revalidating evidence bodies.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE project_knowledge_deliveries SET items_json = 'unreadable evidence'
      WHERE attempt_id = ${receipt.attemptId} AND message_id = ${receipt.messageId}`;
    assert.deepEqual(yield* readKnowledgeDeliveryState(receipt), {
      sent: true,
      sentThisAttempt: true,
      uncertain: false,
    });
    const replacement = { ...receipt, nativeThreadId: "replacement-native" };
    assert.isFalse((yield* readKnowledgeDeliveryState(replacement)).sent);
    assert.isTrue((yield* readKnowledgeDeliveryState(replacement, "attempt")).sentThisAttempt);
    assert.isFalse(
      (yield* readKnowledgeDeliveryState({
        ...receipt,
        messageId: MessageId.make("another-message"),
      })).sent,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps native attachment occupancy across retries, scrubbing and legacy receipts", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projectId = ProjectId.make("native-delivery-estimate");
    yield* createProject(projectId);
    const fixture = yield* composeDelivery(projectId, "native-delivery");
    const budget = {
      estimatedTokens: fixture.byteLength,
      capacity: 128_000,
      occupancy: 0,
      requestSize: 10,
      headroom: 32_000,
      knowledgeAllowance: 16_000,
      tokenCap: 16_000,
      byteCap: 64_000,
    };
    const receipt = {
      ...fixture.delivery("native-delivery-attempt", "prepared", 1),
      providerThreadId: ProviderThreadId.make("native-delivery-provider-thread"),
      nativeThreadId: "original-native",
      budget,
    };
    const estimate = knowledge.nativeDeliveryEstimate(receipt);
    yield* knowledge.recordDelivery(receipt);
    assert.equal(yield* estimate, 0);
    yield* knowledge.recordDelivery({ ...receipt, status: "sent" });
    assert.equal(yield* estimate, fixture.byteLength);
    // A settled receipt is immutable; another attempt's base-only retry carries no new body.
    yield* knowledge.recordDelivery({ ...receipt, budget: { ...budget, estimatedTokens: 0 } });
    yield* knowledge.recordDelivery({
      ...receipt,
      attemptId: RunAttemptId.make("base-only-retry"),
      status: "sent",
      items: [],
      budget: { ...budget, estimatedTokens: 0 },
      createdAt: DateTime.formatIso(at(2)),
      updatedAt: DateTime.formatIso(at(2)),
    });
    assert.equal(yield* estimate, fixture.byteLength);
    const historyEvidence = deliveredKnowledgeForHistory({
      projectId,
      messages: [
        {
          kind: "user_message",
          threadId: receipt.threadId,
          runId: receipt.runId,
          itemId: TurnItemId.make("original-delivered-item"),
        },
      ],
      userItemId: (messageId) =>
        messageId === receipt.messageId ? "original-delivered-item" : undefined,
    });
    assert.include(
      (yield* historyEvidence).textByItem.get("original-delivered-item")!,
      receipt.items[0]!.text,
    );
    yield* knowledge.recordDelivery({
      ...receipt,
      messageId: MessageId.make("accepted-steering-message"),
      status: "sent",
    });
    assert.equal(yield* estimate, fixture.byteLength * 2);
    for (const [index, excluded] of [
      { status: "prepared" as const },
      { status: "failed" as const },
      { status: "uncertain" as const },
      { nativeThreadId: "old-native" },
      { threadId: ThreadId.make("another-thread") },
      { projectId: ProjectId.make("another-project") },
      { providerInstanceId: ProviderInstanceId.make("another-provider") },
      { providerThreadId: ProviderThreadId.make("another-provider-thread") },
    ].entries()) {
      yield* knowledge.recordDelivery({
        ...receipt,
        status: "sent",
        attemptId: RunAttemptId.make(`excluded-attempt-${index}`),
        messageId: MessageId.make(`excluded-message-${index}`),
        ...excluded,
      });
    }
    assert.equal(yield* estimate, fixture.byteLength * 2);
    assert.equal(yield* knowledge.nativeDeliveryEstimate({ ...receipt, nativeThreadId: null }), 0);
    assert.equal(
      yield* knowledge.nativeDeliveryEstimate({ ...receipt, nativeThreadId: "replacement-native" }),
      0,
    );
    const { estimatedTokens: _size, ...legacyBudget } = budget;
    yield* knowledge.recordDelivery({
      ...receipt,
      status: "sent",
      messageId: MessageId.make("legacy-with-budget"),
      budget: legacyBudget,
    });
    const { budget: _budget, ...legacyReceipt } = receipt;
    yield* knowledge.recordDelivery({
      ...legacyReceipt,
      status: "sent",
      messageId: MessageId.make("legacy-without-budget"),
    });
    for (const [index, legacy] of [
      legacyReceipt,
      { ...legacyReceipt, budget: legacyBudget },
    ].entries())
      yield* knowledge.recordDelivery({
        ...legacy,
        status: "sent",
        messageId: MessageId.make(`legacy-omission-only-${index}`),
        items: [],
        omissions: [{ contextId: "omitted", label: "Omitted", reason: "not_referenced" }],
      });
    const expected = fixture.byteLength * 2 + legacyBudget.knowledgeAllowance + 48_000;
    assert.equal(yield* estimate, expected);
    yield* fixture.forget;
    assert.equal((yield* historyEvidence).textByItem.size, 0);
    assert.equal(
      (yield* fixture.excerpts).find((entry) => entry[0] === receipt.attemptId)?.[2],
      "",
    );
    assert.equal(yield* estimate, expected);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE project_knowledge_deliveries SET items_json = 'unreadable evidence'
      WHERE attempt_id = ${receipt.attemptId} AND message_id = ${receipt.messageId}`;
    assert.equal(yield* estimate, expected);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("pages delivery scrubbing through multiple messages in the same attempt", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projectId = ProjectId.make("steering-scrub-pages");
    yield* createProject(projectId);
    const fixture = yield* composeDelivery(projectId, "scrub-steer");
    const receipt = fixture.delivery("one-attempt", "sent", 1);
    yield* Effect.forEach(
      Array.from({ length: 55 }, (_, index) => index),
      (index) =>
        knowledge.recordDelivery({ ...receipt, messageId: MessageId.make(`steer-${index}`) }),
    );
    const sql = yield* SqlClient.SqlClient;
    // Simulate a removal already committed before the durable scrub continuation runs.
    yield* sql`UPDATE project_knowledge_facts SET status = 'forgotten', content = NULL,
      forgotten_at = '2026-09-27T00:02:00.000Z', entities_json = '[]', tags_json = '[]', sources_json = '[]'
      WHERE project_id = ${projectId}`;
    const afterId = yield* knowledge.scrubDeliveryPage({ projectId });
    assert.isNotNull(afterId);
    assert.equal(yield* knowledge.scrubDeliveryPage({ projectId, afterId: afterId! }), null);
    const [count] = yield* sql<{ total: number; retained: number }>`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN items_json LIKE '%Cache keys include tenant IDs.%' THEN 1 ELSE 0 END) AS retained
      FROM project_knowledge_deliveries WHERE project_id = ${projectId}`;
    assert.equal(count?.total, 55);
    assert.equal(count?.retained, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "scrubs a delivered feedback revision using the citations that supplied its content",
  () =>
    Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const projectId = ProjectId.make("historical-delivery-sources");
      const sourceThreadId = ThreadId.make("historical-source-thread");
      const sourceMessageId = MessageId.make("historical-source-message");
      yield* createProject(projectId);
      yield* projections.apply(thread(sourceThreadId, projectId));
      yield* projections.apply(
        message(sourceThreadId, sourceMessageId, "user", "Cache keys include tenant IDs."),
      );
      const source = yield* knowledge.readSource({
        projectId,
        threadId: sourceThreadId,
        messageId: sourceMessageId,
      });
      if (source.state !== "available") return yield* Effect.die("Expected an available source");
      const created = yield* knowledge.mutate(
        { ...createFact(projectId), sources: [source.source] },
        { kind: "agent-client", sessionId: "historical-source-agent", label: "Agent" },
      );
      const fact = yield* knowledge.mutate(
        {
          action: "feedback",
          helpful: true,
          commandId: CommandId.make("delivered-feedback"),
          projectId,
          factId: created.id,
          expectedRevision: created.revision,
        },
        { kind: "user" },
      );
      const context = {
        environmentId,
        projectId,
        selections: [{ kind: "fact" as const, factId: fact.id, revision: fact.revision }],
        maxBytes: 48000,
      };
      const prepared = yield* knowledge.resolveForTurn(context);
      const threadId = ThreadId.make("historical-delivery-thread");
      const runId = RunId.make("historical-delivery-run");
      yield* knowledge.recordDelivery({
        attemptId: RunAttemptId.make("historical-delivery-attempt"),
        runId,
        threadId,
        messageId: MessageId.make("historical-delivery-message"),
        projectId,
        providerInstanceId,
        status: "sent",
        items: [
          {
            contextId: ComposerContextId.make("historical-context"),
            label: "Fact",
            context,
            text: prepared.text,
          },
        ],
        omissions: [],
        createdAt: DateTime.formatIso(at(1)),
        updatedAt: DateTime.formatIso(at(1)),
      });
      // A new citation cannot replace the provenance of the revision already delivered.
      yield* knowledge.mutate(
        {
          ...createFact(projectId),
          action: "edit",
          commandId: CommandId.make("replace-delivered-fact-source"),
          expectedRevision: fact.revision,
          content: "Cache keys include region IDs.",
        },
        { kind: "user" },
      );
      const read = knowledge.readSentDeliveries({
        projectId,
        threadIds: [threadId],
        runIds: [runId],
      });
      assert.equal((yield* read)[0]?.items[0]?.text, prepared.text);
      yield* projections.apply(
        message(sourceThreadId, sourceMessageId, "user", "The earlier claim was incorrect."),
      );
      const [delivery] = yield* read;
      assert.equal(delivery?.items[0]?.text, "[Source unavailable: removed or changed.]");
      assert.deepEqual(delivery?.omissions, [
        {
          contextId: ComposerContextId.make("historical-context"),
          label: "Fact",
          reason: "source_unavailable",
        },
      ]);
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(
        yield* sql`SELECT attempt_id FROM project_knowledge_deliveries WHERE items_json LIKE '%tenant IDs%'`,
        [],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("preserves valid delivery evidence beyond the recent fact history window", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projectId = ProjectId.make("long-delivery-history");
    yield* createProject(projectId);
    const { delivery, excerpts } = yield* composeDelivery(projectId, "long-history");
    const sent = delivery("long-history-attempt", "sent", 1);
    yield* knowledge.recordDelivery(sent);
    for (let revision = 1; revision <= 51; revision++) {
      yield* knowledge.mutate(
        {
          action: "feedback",
          commandId: CommandId.make(`long-history-feedback-${revision}`),
          projectId,
          factId: ProjectFactId.make("long-history"),
          expectedRevision: revision,
          helpful: true,
        },
        { kind: "user" },
      );
    }
    assert.deepEqual(yield* excerpts, [
      ["long-history-attempt", "sent", sent.items[0]!.text, undefined],
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("scrubs as-sent excerpts of a fact whose id needs JSON escaping", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projectId = ProjectId.make("escaped-delivery-project");
    yield* createProject(projectId);
    const { delivery, forget, excerpts } = yield* composeDelivery(
      projectId,
      "escaped",
      String.raw`say "hi" \o/`,
    );
    yield* knowledge.recordDelivery(delivery("escaped-attempt", "sent", 1));
    yield* forget;
    assert.deepEqual(yield* excerpts, [["escaped-attempt", "sent", "", true]]);
    const sql = yield* SqlClient.SqlClient;
    assert.deepEqual(
      yield* sql`SELECT attempt_id FROM project_knowledge_deliveries WHERE items_json LIKE '%tenant IDs%'`,
      [],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a delivery recorded after its fact was forgotten never restores the excerpt", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projectId = ProjectId.make("late-delivery-project");
    yield* createProject(projectId);
    const sql = yield* SqlClient.SqlClient;
    const stored = sql`SELECT attempt_id FROM project_knowledge_deliveries WHERE items_json LIKE '%tenant IDs%'`;

    // The turn prepared the excerpt, the user forgot the fact, then the provider accepted.
    const settled = yield* composeDelivery(projectId, "settled-after-forget");
    yield* knowledge.recordDelivery(settled.delivery("settled-attempt", "prepared", 1));
    yield* settled.forget;
    yield* knowledge.recordDelivery(settled.delivery("settled-attempt", "sent", 2));
    assert.deepEqual(yield* settled.excerpts, [["settled-attempt", "sent", "", true]]);

    // A record first written after the forget, from an excerpt resolved before it.
    const late = yield* composeDelivery(projectId, "prepared-after-forget");
    yield* late.forget;
    yield* knowledge.recordDelivery(late.delivery("late-attempt", "prepared", 1));
    assert.deepEqual(yield* late.excerpts, [["late-attempt", "prepared", "", true]]);

    assert.deepEqual(yield* stored, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["rolled", "edited", "deleted", "project-deleted", "archive"] as const)(
  "eagerly scrubs unread receipts after %s",
  (removal) =>
    Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const projectId = ProjectId.make("delivered-citations");
      const sink = yield* EventSink.EventSinkV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const apply = Effect.fn("test.persistSourceEvent")(function* (
        event: OrchestrationV2DomainEvent,
      ) {
        yield* sink.write({
          events: [
            { ...event, id: EventId.make(`${event.id}:${DateTime.formatIso(event.occurredAt)}`) },
          ],
        });
      });
      yield* createProject(projectId);
      const deliveredFact = Effect.fn("test.deliveredFact")(function* (key: string) {
        const sourceThreadId = ThreadId.make(`${key}-source-thread`);
        const sourceMessageId = MessageId.make(`${key}-source-message`);
        yield* apply(thread(sourceThreadId, projectId));
        yield* apply(
          message(sourceThreadId, sourceMessageId, "user", `${key}: tenant IDs in cache keys`),
        );
        const source = yield* knowledge.readSource({
          projectId,
          threadId: sourceThreadId,
          messageId: sourceMessageId,
        });
        if (source.state !== "available") return yield* Effect.die("source unavailable");
        const fact = yield* knowledge.mutate(
          { ...createFact(projectId, key), sources: [source.source] },
          { kind: "user" },
        );
        const record = {
          version: 1 as const,
          kind: "project-knowledge" as const,
          contextId: ComposerContextId.make(`${key}-context`),
          label: key,
          knowledge: {
            environmentId,
            projectId,
            selections: [{ kind: "fact" as const, factId: fact.id, revision: fact.revision }],
            maxBytes: 48000,
          },
        };
        const composer = yield* resolveKnowledgeComposer({
          projectId,
          text: `Use this. ${formatComposerContextReference(record)}`,
          records: [record],
        });
        const threadId = ThreadId.make(`${key}-delivery-thread`);
        const messageId = MessageId.make(`${key}-delivery-message`);
        yield* knowledge.recordDelivery({
          attemptId: RunAttemptId.make(`${key}-attempt`),
          runId: RunId.make(`${key}-run`),
          threadId,
          messageId,
          projectId,
          providerInstanceId,
          status: "sent",
          items: composer.items,
          omissions: composer.omissions,
          createdAt: DateTime.formatIso(at(2)),
          updatedAt: DateTime.formatIso(at(2)),
        });
        const current = Effect.map(
          knowledge.readDeliveries({ projectId, threadId, messageId }),
          (read) => read.deliveries[0]?.items[0]?.current,
        );
        const retained = knowledge.readSentDeliveries({
          projectId,
          threadIds: [threadId],
          runIds: [RunId.make(`${key}-run`)],
        });
        return { sourceThreadId, sourceMessageId, current, retained, factId: fact.id };
      });
      const edited = yield* deliveredFact("edited");
      const deleted = yield* deliveredFact("deleted");
      const rolled = yield* deliveredFact("rolled");
      const runId = RunId.make("rolled-source-run");
      const rolledMessage = message(
        rolled.sourceThreadId,
        rolled.sourceMessageId,
        "user",
        "rolled: tenant IDs in cache keys",
      );
      if (rolledMessage.type !== "message.updated") return yield* Effect.die("Expected message");
      yield* apply({
        ...rolledMessage,
        id: EventId.make("rolled-message-run"),
        payload: { ...rolledMessage.payload, runId },
      });
      yield* apply({
        id: EventId.make("rolled-source-event"),
        type: "run.updated",
        threadId: rolled.sourceThreadId,
        runId,
        occurredAt: at(4),
        payload: {
          id: runId,
          threadId: rolled.sourceThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          providerThreadId: null,
          userMessageId: rolled.sourceMessageId,
          rootNodeId: NodeId.make("rolled-root"),
          activeAttemptId: null,
          status: "rolled_back",
          requestedAt: at(1),
          startedAt: at(1),
          completedAt: at(4),
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const sql = yield* SqlClient.SqlClient;
      yield* worker.drain();
      if (removal === "rolled") {
        assert.deepEqual(
          yield* sql`SELECT attempt_id FROM project_knowledge_deliveries WHERE attempt_id = 'rolled-attempt' AND items_json LIKE '%Cache keys include tenant IDs.%'`,
          [],
        );
        return;
      }
      const search = yield* ThreadSearch.ThreadSearch;
      assert.deepEqual((yield* search.search({ projectId, query: "rolled: tenant" })).matches, []);

      yield* apply(
        message(edited.sourceThreadId, edited.sourceMessageId, "user", "edited later", {
          minute: 3,
        }),
      );
      const deletedThread = yield* projections.getThreadRecords(deleted.sourceThreadId, []);
      yield* apply({
        id: EventId.make("delete-delivered-citation"),
        threadId: deleted.sourceThreadId,
        type: "thread.deleted",
        occurredAt: at(4),
        payload: { ...deletedThread.thread, deletedAt: at(4) },
      });

      yield* worker.drain();
      if (removal === "edited")
        assert.deepEqual(
          yield* sql`SELECT attempt_id FROM project_knowledge_deliveries WHERE attempt_id = 'edited-attempt' AND items_json LIKE '%Cache keys include tenant IDs.%'`,
          [],
        );
      if (removal === "deleted")
        assert.deepEqual(
          yield* sql`SELECT attempt_id FROM project_knowledge_deliveries WHERE attempt_id = 'deleted-attempt' AND items_json LIKE '%Cache keys include tenant IDs.%'`,
          [],
        );
      if (removal === "edited" || removal === "deleted") return;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      yield* maintenance.rebuild;
      assert.deepEqual(
        (yield* search.search({ projectId, query: "tenant IDs in cache keys" })).matches,
        [],
      );
      for (const entry of [edited, deleted, rolled]) {
        const detail = yield* knowledge.readFact({ projectId, factId: entry.factId });
        assert.isNotNull(detail.sourceUnavailable);
        const resolved = yield* knowledge
          .resolveForTurn({
            environmentId,
            projectId,
            selections: [{ kind: "fact", factId: entry.factId, revision: 1 }],
            maxBytes: 48000,
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(resolved));
        const rows = yield* entry.retained;
        assert.notInclude(rows[0]?.items[0]?.text, "Cache keys include tenant IDs.");
        assert.include(rows[0]?.items[0]?.text, "Source unavailable");
        const row = rows[0]!;
        const replay = yield* deliveredKnowledgeForHistory({
          projectId,
          messages: [
            {
              itemId: TurnItemId.make("removed-source-replay"),
              role: "user",
              kind: "user_message",
              text: "Use this.",
              threadId: row.threadId,
              runId: row.runId,
              providerThreadId: null,
              status: "completed",
            },
          ],
          userItemId: () => "removed-source-replay",
        });
        assert.notInclude(
          replay.textByItem.get("removed-source-replay"),
          "Cache keys include tenant IDs.",
        );
        assert.include(replay.textByItem.get("removed-source-replay"), "Source unavailable");
        assert.deepEqual(replay.factIdsByItem.get("removed-source-replay"), []);
      }
      const uncited = yield* deliveredFact("project-deleted");
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      if (removal === "archive") {
        const archived = yield* deliveredFact("archived");
        const records = yield* projections.getThreadRecords(archived.sourceThreadId, []);
        yield* apply({
          id: EventId.make("archive-retained"),
          threadId: archived.sourceThreadId,
          type: "thread.archived",
          occurredAt: at(4),
          payload: { ...records.thread, archivedAt: at(4) },
        });
        yield* worker.drain();
        assert.include(
          JSON.stringify(
            yield* sql`SELECT items_json FROM project_knowledge_deliveries WHERE attempt_id = 'archived-attempt'`,
          ),
          "Cache keys include tenant IDs.",
        );
        return;
      }
      if (removal === "project-deleted") {
        for (let index = 0; index < 51; index++) yield* deliveredFact(`page-${index}`);
      }
      yield* sink.commitProjectCommand({
        commandId: CommandId.make("delete-delivery-project"),
        projectId,
        commandType: "project.delete",
        acceptedAt: at(5),
        event: {
          eventId: EventId.make("delete-delivery-project"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: DateTime.formatIso(at(5)),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.deleted",
          payload: { projectId, deletedAt: DateTime.formatIso(at(5)) },
        },
      });
      assert.deepEqual(
        yield* knowledge.readSource({
          projectId,
          threadId: edited.sourceThreadId,
          messageId: edited.sourceMessageId,
        }),
        { state: "unavailable", reason: "deleted" },
      );
      yield* worker.drain();
      if (removal === "project-deleted")
        assert.deepEqual(
          yield* sql`SELECT attempt_id FROM project_knowledge_deliveries WHERE attempt_id = 'project-deleted-attempt' AND items_json LIKE '%Cache keys include tenant IDs.%'`,
          [],
        );
      if (removal === "project-deleted")
        assert.deepEqual(
          yield* sql`SELECT attempt_id FROM project_knowledge_deliveries WHERE project_id = ${projectId} AND items_json LIKE '%Cache keys include tenant IDs.%'`,
          [],
        );
      const afterDelete = yield* uncited.retained;
      assert.notInclude(afterDelete[0]?.items[0]?.text, "Cache keys include tenant IDs.");
      assert.include(afterDelete[0]?.items[0]?.text, "Source unavailable");
      assert.equal(afterDelete[0]?.omissions.at(-1)?.reason, "source_unavailable");
      assert.isTrue(
        Result.isFailure(
          yield* knowledge.readFact({ projectId, factId: uncited.factId }).pipe(Effect.result),
        ),
      );
      const beforeRetry =
        yield* sql`SELECT items_json, omissions_json FROM project_knowledge_deliveries ORDER BY attempt_id`;
      yield* outbox.enqueue([deliveryScrubEffect({ projectId, removalId: "retry-test" })]);
      yield* worker.drain();
      assert.deepEqual(
        yield* sql`SELECT items_json, omissions_json FROM project_knowledge_deliveries ORDER BY attempt_id`,
        beforeRetry,
      );
    }).pipe(Effect.provide(receiptTestLayer)),
);

it.effect("browsing searches can opt out of reinforcing retrieval counts", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projectId = ProjectId.make("browsing-search");
    yield* createProject(projectId);
    yield* knowledge.mutate(createFact(projectId), { kind: "user" });
    const searchCount = Effect.fn("test.searchCount")(function* (
      requestId: string,
      recordRetrieval?: boolean,
    ) {
      const result = yield* knowledge.search({
        projectId,
        query: "tenant cache",
        requestId: CommandId.make(requestId),
        ...(recordRetrieval === undefined ? {} : { recordRetrieval }),
      });
      return result.facts.state === "available"
        ? result.facts.matches[0]?.fact.retrievalCount
        : undefined;
    });
    const storedCount = Effect.map(
      knowledge.list({ projectId }),
      (listed) => listed.facts[0]?.retrievalCount,
    );
    const recalled = Effect.fn("test.recalled")(function* (requestId: string, query: string) {
      const composer = attachedComposer(
        yield* knowledge.recall({
          projectId,
          threadId: ThreadId.make("recall-thread"),
          requestId: CommandId.make(requestId),
          query,
          composer: { text: query, records: [] },
          knowledgeAllowance: 48000,
        }),
      );
      const record = composer?.records.find((item) => item.kind === "project-knowledge");
      return record?.kind === "project-knowledge" && "knowledge" in record
        ? record.knowledge.selections.flatMap((selection) =>
            selection.kind === "fact" ? [selection.factId] : [],
          )
        : [];
    });
    assert.deepEqual(yield* recalled("suggest-greeting", "hello there"), []);
    const sql = yield* SqlClient.SqlClient;
    const longQuery = "cache keys tenant ".repeat(100);
    for (const [name, query] of [
      ["short", "cache keys tenant"],
      ["limit", longQuery.slice(0, THREAD_SEARCH_QUERY_MAX_LENGTH)],
      ["over-limit", longQuery.slice(0, THREAD_SEARCH_QUERY_MAX_LENGTH + 1)],
      ["long-with-whitespace", ` \n\t${longQuery}\n\t `],
      [
        "truncated-copy",
        `${"Cache keys include tenant IDs.".padEnd(8_192)}Should we change that requirement?`,
      ],
    ] as const) {
      const requestId = CommandId.make(`suggest-relevant-${name}`);
      assert.deepEqual(yield* recalled(requestId, query), [ProjectFactId.make("fact-one")]);
      assert.equal(yield* storedCount, 0);
      assert.equal(
        (yield* sql`SELECT command_id FROM project_knowledge_commands WHERE command_id = ${requestId}`)
          .length,
        0,
      );
    }

    assert.deepEqual(
      yield* recalled(
        "suggest-weak",
        "tenant garden bicycle banana weather holiday mountain sunset",
      ),
      [],
    );
    yield* knowledge.mutate(
      {
        ...createFact(projectId, "unicode"),
        content: "缓存键必须包含租户标识",
        entities: [],
        tags: [],
      },
      { kind: "user" },
    );
    assert.deepEqual(yield* recalled("suggest-unicode", "缓存键必须包含租户标识"), [
      ProjectFactId.make("unicode"),
    ]);
    assert.deepEqual(yield* recalled("suggest-filler", "please can you help"), []);
    assert.equal(yield* storedCount, 0);
    assert.equal(yield* searchCount("browse", false), 0);
    assert.equal(yield* storedCount, 0);
    assert.equal(yield* searchCount("agent"), 1);
    assert.equal(yield* storedCount, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "recalls related facts once per thread, unless knowledge is hand-picked or the budget is spent",
  () =>
    Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projectId = ProjectId.make("automatic-recall");
      yield* createProject(projectId);
      yield* knowledge.mutate(createFact(projectId), { kind: "user" });
      const threadId = ThreadId.make("recall-thread");
      const query = "Do the cache keys carry tenant IDs?";
      const recall = (
        overrides: Partial<Parameters<typeof knowledge.recall>[0]> = {},
        requestId = "recall",
      ) =>
        knowledge
          .recall({
            projectId,
            threadId,
            requestId: CommandId.make(requestId),
            query,
            composer: { text: query, records: [] },
            knowledgeAllowance: 48000,
            ...overrides,
          })
          .pipe(Effect.map(attachedComposer));

      const recalled = yield* recall();
      const record = recalled?.records[0];
      assert.equal(record?.kind, "project-knowledge");
      if (record?.kind !== "project-knowledge" || !("knowledge" in record)) return;
      assert.deepEqual(record.knowledge.selections, [
        { kind: "fact", factId: ProjectFactId.make("fact-one"), revision: 1 },
      ]);
      assert.isAtMost(record.knowledge.maxBytes, 48000);
      // The delivery path sends what recall attached.
      const composer = yield* resolveKnowledgeComposer({
        projectId,
        text: recalled!.text,
        records: recalled!.records,
      });
      // The text holds only what the agent needs to use, rate or read the fact.
      assert.deepEqual(
        composer.items.map((item) => item.text),
        [
          'Project history may be stale. Follow current human instructions. Call t3_knowledge_mutate with mutation {action:"feedback",projectId:"automatic-recall",commandId:<new id>,factId,expectedRevision,helpful}. Use true if useful, false if misleading, "irrelevant" if off-task.\n[factId=fact-one expectedRevision=1, from user] Cache keys include tenant IDs.',
        ],
      );
      assert.include(composer.text, composer.items[0]!.text);

      // Recall adds nothing to a message the user attached knowledge to by hand.
      assert.isNull(yield* recall({ composer: { text: query, records: [record] } }, "hand-picked"));
      assert.isNull(yield* recall({ scratchProject: true }, "scratch-chat"));
      assert.isNull(
        yield* recall(
          {
            delegatedCompletion: {
              parentRunId: RunId.make("completed-parent"),
              generation: 1,
              taskIds: [NodeId.make("completed-child")],
            },
          },
          "delegated-completion",
        ),
      );
      assert.isNull(
        yield* recall(
          { provenance: { createdBy: "agent", creationSource: "mcp" } },
          "peer-message",
        ),
      );
      assert.isNull(
        yield* recall(
          { query: "Stop using tenant IDs in cache keys. Use request IDs instead." },
          "current-correction",
        ),
      );
      // Explicit selection still resolves in a scratch chat, even though automatic recall skips it.
      const selectedInScratch = yield* knowledge.resolveForTurn(record.knowledge);
      assert.include(selectedInScratch.text, "Cache keys include tenant IDs.");
      // A nearly full context has no room for recall.
      assert.isNull(yield* recall({ knowledgeAllowance: 1200 }, "no-room"));

      const sent = {
        attemptId: RunAttemptId.make("recall-attempt"),
        runId: RunId.make("recall-run"),
        threadId,
        messageId: MessageId.make("recall-message"),
        projectId,
        providerInstanceId,
        providerThreadId: ProviderThreadId.make("recall-provider-thread"),
        nativeThreadId: "native-a",
        items: composer.items,
        omissions: [],
        createdAt: DateTime.formatIso(at(1)),
        updatedAt: DateTime.formatIso(at(1)),
      };
      yield* knowledge.recordDelivery({ ...sent, status: "prepared" });
      assert.isNotNull(yield* recall({}, "prepared-only"));
      yield* knowledge.recordDelivery({ ...sent, status: "sent" });
      // Recall does not resend a fact the thread received, but another thread still gets it.
      assert.isNull(yield* recall({}, "already-sent"));
      assert.isNotNull(yield* recall({ threadId: ThreadId.make("other-thread") }, "other-thread"));
      // A retry of that message on a replacement conversation never received the fact.
      const retry = {
        messageId: sent.messageId,
        attemptId: RunAttemptId.make("recall-retry"),
        providerInstanceId,
        providerThreadId: sent.providerThreadId,
        nativeThreadId: "native-b",
      };
      assert.isNotNull(yield* recall({ turn: retry }, "retry-elsewhere"));
      assert.isNull(
        yield* recall({ turn: { ...retry, nativeThreadId: "native-a" } }, "retry-same"),
      );
      const later = { ...retry, messageId: MessageId.make("later-message") };
      assert.isNull(yield* recall({ turn: later }, "later-message"));
      assert.isNotNull(
        yield* recall(
          {
            turn: {
              ...retry,
              nativeThreadId: "native-a",
              providerInstanceId: ProviderInstanceId.make("other-provider"),
            },
          },
          "retry-other-provider",
        ),
      );
      assert.isNotNull(
        yield* recall(
          {
            turn: {
              ...retry,
              nativeThreadId: "native-a",
              providerThreadId: ProviderThreadId.make("other-provider-thread"),
            },
          },
          "retry-other-provider-thread",
        ),
      );
      yield* knowledge.recordDelivery({ ...sent, nativeThreadId: null, status: "sent" });
      assert.isNull(
        yield* recall(
          { turn: { ...retry, attemptId: sent.attemptId, nativeThreadId: null } },
          "same-attempt-without-native-id",
        ),
      );
      assert.isNotNull(
        yield* recall({ turn: { ...retry, nativeThreadId: null } }, "retry-without-native-id"),
      );

      // Recall cuts a long fact short and names the tool that reads the rest.
      yield* knowledge.mutate(
        {
          ...createFact(projectId, "long"),
          content: `Cache keys include tenant IDs. ${"cache keys ".repeat(400)}`.trim(),
        },
        { kind: "user" },
      );
      const long = yield* recall({}, "long");
      const sentLong = yield* resolveKnowledgeComposer({
        projectId,
        text: long!.text,
        records: long!.records,
      });
      const [longText] = sentLong.items.map((item) => item.text);
      assert.include(
        longText,
        "[factId=long expectedRevision=1, from user] Cache keys include tenant IDs.",
      );
      assert.include(longText, "t3_knowledge_read_fact");
      assert.isAtMost(longText!.length, 1100);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("does not recall a fact the thread's agent has already been shown", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectId = ProjectId.make("recall-seen");
    yield* createProject(projectId);
    const query = "Do the cache keys carry tenant IDs?";
    // The facts differ enough that reading one does not quote another as a look-alike.
    const contents = {
      one: "Cache keys include tenant IDs, rule one.",
      two: "Tenant IDs go first in cache keys so shards stay balanced.",
      three: "Changing cache keys needs a reviewed migration plan and a rollback for tenant IDs.",
    };
    const ids = Object.keys(contents).map((id) => ProjectFactId.make(id));
    for (const [id, content] of Object.entries(contents))
      yield* knowledge.mutate({ ...createFact(projectId, id), content }, { kind: "user" });
    const recall = (threadId: ThreadId, requestId: string) =>
      knowledge
        .recall({
          projectId,
          threadId,
          requestId: CommandId.make(requestId),
          query,
          composer: { text: query, records: [] },
          knowledgeAllowance: 48000,
        })
        .pipe(Effect.map(attachedComposer));
    const recalledIn = Effect.fn("test.recalledIn")(function* (thread: string, request = thread) {
      const composer = yield* recall(ThreadId.make(thread), `recall-${request}`);
      return (composer?.records ?? []).flatMap((record) =>
        record.kind === "project-knowledge" && "knowledge" in record
          ? record.knowledge.selections.flatMap((selection) =>
              selection.kind === "fact" ? [selection.factId] : [],
            )
          : [],
      );
    });
    assert.lengthOf(yield* recalledIn("fresh"), 2);
    // Reads every fact except `rest` in a thread, so recall can return only `rest`.
    const readAllBut = Effect.fn("test.readAllBut")(function* (
      thread: string,
      rest: ReadonlyArray<ProjectFactId>,
    ) {
      for (const factId of ids)
        if (!rest.includes(factId))
          yield* knowledge.readFact({ projectId, factId }, ThreadId.make(thread));
    });

    // Recall does not resend what the agent's own search or listing returned.
    const searched = yield* knowledge.search(
      { projectId, query: "tenant cache keys", requestId: CommandId.make("agent-search") },
      ThreadId.make("searched"),
    );
    if (searched.facts.state !== "available") return assert.fail("ranking must be available");
    const found = searched.facts.matches.map(({ fact }) => fact.id);
    assert.isNotEmpty(found);
    yield* readAllBut("searched", found);
    assert.deepEqual(yield* recalledIn("searched"), []);
    yield* knowledge.list({ projectId }, ThreadId.make("listed"));
    assert.deepEqual(yield* recalledIn("listed"), []);

    // After the agent reads two facts, recall returns the third, wherever it ranks.
    for (const unseen of ids) {
      yield* readAllBut(`read-all-but-${unseen}`, [unseen]);
      assert.deepEqual(yield* recalledIn(`read-all-but-${unseen}`), [unseen]);
    }

    // Saving a near duplicate returns excerpts of similar facts, so its agent has seen them.
    const duplicate = yield* knowledge.mutateWithHints(
      {
        ...createFact(projectId, "duplicate"),
        content: "Cache keys include tenant IDs, rule one!",
        sources: [],
      },
      { kind: "agent-thread", threadId: ThreadId.make("hinted"), providerInstanceId },
    );
    const hinted = (duplicate.hints ?? []).map((hint) => hint.factId);
    assert.isNotEmpty(hinted);
    yield* readAllBut("hinted", hinted);
    assert.deepEqual(yield* recalledIn("hinted"), []);
    // Reading a fact returns excerpts of similar facts too.
    yield* knowledge.readFact(
      { projectId, factId: ProjectFactId.make("duplicate") },
      ThreadId.make("quoted"),
    );
    yield* readAllBut("quoted", hinted);
    assert.deepEqual(yield* recalledIn("quoted"), []);

    // A delivery whose outcome is unknown may have reached the agent.
    const [maybeSent] = yield* recalledIn("uncertain", "uncertain-first");
    const unsure = yield* recall(ThreadId.make("uncertain"), "recall-uncertain-items");
    const { items } = yield* resolveKnowledgeComposer({
      projectId,
      text: unsure!.text,
      records: unsure!.records,
    });
    yield* knowledge.recordDelivery({
      attemptId: RunAttemptId.make("uncertain-attempt"),
      runId: RunId.make("uncertain-run"),
      threadId: ThreadId.make("uncertain"),
      messageId: MessageId.make("uncertain-message"),
      projectId,
      providerInstanceId,
      status: "uncertain",
      items,
      omissions: [],
      createdAt: DateTime.formatIso(at(1)),
      updatedAt: DateTime.formatIso(at(1)),
    });
    assert.notInclude(yield* recalledIn("uncertain", "uncertain-second"), maybeSent);
    // Rolling a run back removes its facts from the conversation, so recall may send them again.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('uncertain-run', 'uncertain', 1, 'codex', 'rolled_back', ${DateTime.formatIso(at(1))}, '{}')`;
    assert.include(yield* recalledIn("uncertain", "uncertain-rolled-back"), maybeSent);

    // A fork replays the facts its parent received, so they are in the fork's context too.
    const parent = ThreadId.make("parent");
    const toParent = yield* recall(parent, "recall-parent");
    const parentDelivery = yield* resolveKnowledgeComposer({
      projectId,
      text: toParent!.text,
      records: toParent!.records,
    });
    yield* knowledge.recordDelivery({
      attemptId: RunAttemptId.make("parent-attempt"),
      runId: RunId.make("parent-run"),
      threadId: parent,
      messageId: MessageId.make("parent-message"),
      projectId,
      providerInstanceId,
      status: "sent",
      items: parentDelivery.items,
      omissions: [],
      createdAt: DateTime.formatIso(at(2)),
      updatedAt: DateTime.formatIso(at(2)),
    });
    const inherited = yield* deliveredKnowledgeForHistory({
      projectId,
      messages: [
        {
          itemId: TurnItemId.make("item:parent"),
          kind: "user_message",
          threadId: parent,
          runId: RunId.make("parent-run"),
        },
      ],
      userItemId: () => "item:parent",
    });
    assert.isNotEmpty(yield* recalledIn("fork", "before-replay"));
    yield* knowledge.recordViews(
      projectId,
      ThreadId.make("fork"),
      inherited.factIdsByItem.get("item:omitted") ?? [],
    );
    assert.isNotEmpty(yield* recalledIn("fork", "omitted-replay"));
    const inheritedFactIds = inherited.factIdsByItem.get("item:parent") ?? [];
    assert.sameMembers(
      [...inheritedFactIds],
      parentDelivery.items.flatMap((item) =>
        item.context.selections.flatMap((selection) =>
          selection.kind === "fact" ? [selection.factId] : [],
        ),
      ),
    );
    yield* knowledge.recordViews(projectId, ThreadId.make("fork"), inheritedFactIds);
    yield* readAllBut("fork", inheritedFactIds);
    assert.deepEqual(yield* recalledIn("fork"), []);

    // A fact that cites a thread's own message is recalled only in other threads, and without
    // its citation.
    const origin = ThreadId.make("origin-thread");
    yield* projections.apply(thread(origin, projectId));
    yield* projections.apply(message(origin, "origin-message", "user", "tenant IDs in keys"));
    const source = yield* knowledge.readSource({
      projectId,
      threadId: origin,
      messageId: MessageId.make("origin-message"),
    });
    if (source.state !== "available") return yield* Effect.die("source unavailable");
    yield* readAllBut("origin-thread", []);
    yield* readAllBut("elsewhere", []);
    yield* knowledge.mutate(
      {
        ...createFact(projectId, "cited"),
        content: "Cache keys include tenant IDs, rule cited.",
        sources: [source.source],
      },
      { kind: "user" },
    );
    assert.deepEqual(yield* recalledIn("origin-thread"), []);
    const elsewhere = yield* recall(ThreadId.make("elsewhere"), "recall-elsewhere");
    const delivered = yield* resolveKnowledgeComposer({
      projectId,
      text: elsewhere!.text,
      records: elsewhere!.records,
    });
    assert.include(
      delivered.text,
      "[factId=cited expectedRevision=1, from user] Cache keys include tenant IDs",
    );
    assert.notInclude(delivered.text, "sha256");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("recalls unseen facts beyond a full page of facts the thread has read", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projectId = ProjectId.make("recall-seen-page");
    const threadId = ThreadId.make("recall-seen-page-thread");
    yield* createProject(projectId);
    const ids = Array.from({ length: 10 }, (_, index) => `fact-${index}`);
    for (const id of ids) yield* knowledge.mutate(createFact(projectId, id), { kind: "user" });
    const read = yield* knowledge.list({ projectId, limit: 9 }, threadId);
    assert.deepEqual(
      read.facts.map((fact) => fact.id),
      ids.slice(0, 9),
    );
    const query = "Do the cache keys carry tenant IDs?";
    const recalled = attachedComposer(
      yield* knowledge.recall({
        projectId,
        threadId,
        requestId: CommandId.make("recall-after-first-page"),
        query,
        composer: { text: query, records: [] },
        knowledgeAllowance: 48000,
      }),
    );
    const record = recalled?.records[0];
    assert.equal(record?.kind, "project-knowledge");
    if (record?.kind !== "project-knowledge" || !("knowledge" in record)) return;
    assert.deepEqual(record.knowledge.selections, [
      { kind: "fact", factId: ProjectFactId.make("fact-9"), revision: 1 },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("recall keeps the most trusted fact when more than the bound match equally", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("recall-trust-tie");
    yield* createProject(projectId);
    const ids = Array.from({ length: 41 }, (_, index) =>
      ProjectFactId.make(`tie-${index.toString().padStart(2, "0")}`),
    );
    for (const factId of ids)
      yield* knowledge.mutate(createFact(projectId, factId), { kind: "user" });
    yield* sql`UPDATE project_knowledge_facts SET trust = 1 WHERE id = ${ids[40]!}`;
    const query = "Do the cache keys carry tenant IDs?";
    const outcome = yield* knowledge.recall({
      projectId,
      threadId: ThreadId.make("recall-trust-tie"),
      requestId: CommandId.make("recall-trust-tie"),
      query,
      composer: { text: query, records: [] },
      knowledgeAllowance: 48000,
    });
    assert.equal(attachedFactIds(outcome)[0], ids[40]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("automatic recall requires human support for learned and agent policy facts", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("recall-authority");
    const sourceThreadId = ThreadId.make("recall-authority-source");
    yield* createProject(projectId);
    yield* projections.apply(thread(sourceThreadId, projectId));
    yield* projections.apply(
      message(sourceThreadId, "human-policy", "user", "Cache keys must include tenant IDs."),
    );
    yield* projections.apply(
      message(sourceThreadId, "agent-policy", "assistant", "Cache keys must include tenant IDs."),
    );
    const citations = [];
    for (const messageId of ["human-policy", "agent-policy"]) {
      const source = yield* knowledge.readSource({
        projectId,
        threadId: sourceThreadId,
        messageId: MessageId.make(messageId),
      });
      if (source.state !== "available") return yield* Effect.die("source unavailable");
      citations.push(source.source);
    }
    const actor = {
      kind: "assisted" as const,
      threadId: sourceThreadId,
      runId: RunId.make("recall-authority-run"),
      runOutcome: "completed" as const,
    };
    for (const [factId, citation] of [
      ["human-backed", citations[0]!],
      ["agent-only", citations[1]!],
    ] as const) {
      yield* knowledge.saveAutomatic(
        {
          ...createFact(projectId, factId),
          content: `Cache keys include tenant IDs in ${factId} jobs.`,
          sources: [citation],
        },
        actor,
      );
    }
    const agent = { kind: "agent-thread" as const, threadId: sourceThreadId, providerInstanceId };
    yield* knowledge.mutate(
      {
        ...createFact(projectId, "agent-policy"),
        content: "Cache keys include tenant IDs for all new jobs.",
        sources: [citations[1]!],
      },
      agent,
    );
    yield* knowledge.mutate(
      {
        ...createFact(projectId, "agent-observation"),
        content: "Cache keys include tenant IDs in observed production responses.",
        kind: "note",
        sources: [citations[1]!],
      },
      agent,
    );
    const query = "Do cache keys carry tenant IDs?";
    const recall = (requestId: string) =>
      knowledge.recall({
        projectId,
        threadId: ThreadId.make("recall-authority-reader"),
        requestId: CommandId.make(requestId),
        query,
        composer: { text: query, records: [] },
        knowledgeAllowance: 48000,
      });
    const eligible = [ProjectFactId.make("human-backed"), ProjectFactId.make("agent-observation")];
    assert.deepEqual(
      attachedFactIds(yield* recall("before-curation")).toSorted(),
      eligible.toSorted(),
    );
    const learned = (yield* knowledge.readFact({
      projectId,
      factId: ProjectFactId.make("agent-only"),
    })).fact;
    yield* knowledge.mutate(
      {
        ...createFact(projectId, "agent-only"),
        action: "edit",
        commandId: CommandId.make("curate-agent-policy"),
        expectedRevision: learned.revision,
        content: "Cache keys must always include tenant IDs in every job.",
        sources: [citations[1]!],
      },
      agent,
    );
    assert.deepEqual(
      attachedFactIds(yield* recall("after-curation")).toSorted(),
      eligible.toSorted(),
    );
    const explicit = yield* knowledge.resolveForTurn({
      environmentId,
      projectId,
      selections: [{ kind: "fact", factId: learned.id, revision: learned.revision + 1 }],
      maxBytes: 48000,
    });
    assert.include(explicit.text, "Cache keys must always include tenant IDs in every job.");
    let approved = (yield* knowledge.readFact({ projectId, factId: learned.id })).fact;
    // Current agent mutations reject synthetic user citations; seed a legacy record directly.
    const seedLegacyUserSource = () =>
      sql`UPDATE project_knowledge_facts
        SET sources_json = ${JSON.stringify([...approved.sources, { kind: "user" }])}
        WHERE project_id = ${projectId} AND id = ${approved.id}`;
    for (const action of ["edit", "supersede"] as const) {
      yield* seedLegacyUserSource();
      assert.deepEqual(
        attachedFactIds(yield* recall(`before-owner-restore-${action}`)).toSorted(),
        eligible.toSorted(),
      );
      const restore = {
        action: "restore" as const,
        projectId,
        factId: approved.id,
        expectedRevision: approved.revision,
        commandId: CommandId.make(`owner-restore-${action}`),
      };
      assert.equal(
        (yield* knowledge.mutate(restore, agent).pipe(Effect.flip)).reason,
        "user_required",
      );
      approved = yield* knowledge.mutate(restore, { kind: "user" });
      assert.equal(approved.verdict?.by, "person");
      const restoredIds = attachedFactIds(yield* recall(`after-owner-restore-${action}`));
      assert.include(restoredIds, approved.id);
      assert.lengthOf(restoredIds, 2);
      assert.isTrue(restoredIds.every((id) => [...eligible, approved.id].includes(id)));

      const rewritten = {
        ...createFact(projectId, approved.id),
        commandId: CommandId.make(`rewrite-owner-restored-${action}`),
        expectedRevision: approved.revision,
        content: `Cache keys must include tenant IDs in ${action} jobs.`,
        sources: [citations[1]!],
      };
      approved = yield* knowledge.mutate(
        action === "edit"
          ? { ...rewritten, action }
          : {
              ...rewritten,
              action,
              replacementFactId: ProjectFactId.make("agent-policy-replacement"),
            },
        agent,
      );
      assert.isUndefined(approved.verdict);
      assert.deepEqual(
        attachedFactIds(yield* recall(`after-agent-rewrite-${action}`)).toSorted(),
        eligible.toSorted(),
      );
    }

    yield* seedLegacyUserSource();
    yield* knowledge.mutate(
      {
        action: "restore",
        projectId,
        factId: approved.id,
        expectedRevision: approved.revision,
        commandId: CommandId.make("restore-before-source-change"),
      },
      { kind: "user" },
    );
    yield* projections.apply(
      message(sourceThreadId, "agent-policy", "assistant", "This report was withdrawn.", {
        minute: 2,
      }),
    );
    assert.deepEqual(attachedFactIds(yield* recall("after-source-change")), [
      ProjectFactId.make("human-backed"),
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["check", "agent"] as const)(
  "recall and default retrieval exclude facts set aside by %s until explicitly requested",
  (verdictBy) =>
    Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("recall-set-aside");
      yield* createProject(projectId);
      const standing = ProjectFactId.make("standing");
      const setAside = ProjectFactId.make("set-aside");
      const unchecked = ProjectFactId.make("unchecked");
      for (const factId of [standing, setAside, unchecked])
        yield* knowledge.mutate(createFact(projectId, factId), { kind: "user" });
      for (const [factId, verdict] of [
        [standing, "standing"],
        [setAside, "task"],
      ] as const)
        yield* sql`UPDATE project_knowledge_facts
        SET verdict = ${verdict}, verdict_by = ${verdictBy}, verdict_at = '2026-11-16T00:00:00.000Z'
        WHERE id = ${factId}`;
      const recall = (id: string, query: string) =>
        knowledge.recall({
          projectId,
          threadId: ThreadId.make(id),
          requestId: CommandId.make(id),
          query,
          composer: { text: query, records: [] },
          knowledgeAllowance: 48000,
        });
      const tenantQuery = "Should tenant IDs be part of the new cache keys?";
      assert.deepEqual(attachedFactIds(yield* recall("recall-set-aside", tenantQuery)).toSorted(), [
        standing,
        unchecked,
      ]);
      const searched = yield* knowledge.search({
        projectId,
        query: "tenant cache",
        requestId: CommandId.make("search-set-aside"),
      });
      assert.deepEqual(
        searched.facts.state === "available"
          ? searched.facts.matches.map((match) => match.fact.id).toSorted()
          : [],
        [standing, unchecked],
      );
      assert.deepEqual(
        (yield* knowledge.list({ projectId })).facts.map((fact) => fact.id),
        [standing, unchecked],
      );
      assert.deepEqual(
        (yield* knowledge.list({ projectId, verdict: "set_aside" })).facts.map((fact) => fact.id),
        [setAside],
      );
      const edit = (commandId: string, content: string, actor: KnowledgeOrigin) =>
        Effect.gen(function* () {
          const { fact } = yield* knowledge.readFact({ projectId, factId: setAside });
          yield* knowledge.mutate(
            {
              ...createFact(projectId, setAside),
              action: "edit",
              commandId: CommandId.make(commandId),
              expectedRevision: fact.revision,
              content,
              // Agents cannot cite the user; an agent's edit may carry no sources.
              sources: actor.kind === "user" ? [{ kind: "user" }] : [],
            },
            actor,
          );
          return (yield* knowledge.readFact({ projectId, factId: setAside })).fact.verdict?.value;
        });
      // An agent rewording a set-aside fact has not decided that it should be recalled.
      assert.equal(
        yield* edit("agent-edit-set-aside", "Cache keys include tenant IDs and regions.", {
          kind: "agent-thread",
          threadId: ThreadId.make("editing-agent"),
          providerInstanceId,
        }),
        "task",
      );
      assert.deepEqual(
        attachedFactIds(yield* recall("recall-after-agent-edit", "Add regions to cache keys.")),
        [],
      );
      assert.equal(
        yield* edit("edit-unchanged-set-aside", "Cache keys include tenant IDs and regions.", {
          kind: "user",
        }),
        "task",
      );
      // A person's edit is the owner's way back: the fact is unchecked and recallable again.
      assert.isUndefined(
        yield* edit("edit-set-aside", "Cache keys include tenant IDs and region codes.", {
          kind: "user",
        }),
      );
      assert.deepEqual(
        attachedFactIds(yield* recall("recall-after-edit", "Add region codes to cache keys.")),
        [setAside],
      );
      // Nor does an agent's replacement of a set-aside fact make it recallable.
      yield* sql`UPDATE project_knowledge_facts
      SET verdict = 'task', verdict_by = ${verdictBy}, verdict_at = '2026-11-16T00:00:00.000Z'
      WHERE id = ${setAside}`;
      const replacement = ProjectFactId.make("agent-replacement");
      yield* knowledge.mutate(
        {
          ...createFact(projectId, setAside),
          action: "supersede",
          commandId: CommandId.make("agent-supersede-set-aside"),
          expectedRevision: (yield* knowledge.readFact({ projectId, factId: setAside })).fact
            .revision,
          replacementFactId: replacement,
          content: "Cache keys include tenant IDs, region codes and shard numbers.",
          sources: [],
        },
        { kind: "agent-thread", threadId: ThreadId.make("editing-agent"), providerInstanceId },
      );
      assert.equal(
        (yield* knowledge.readFact({ projectId, factId: replacement })).fact.verdict?.value,
        "task",
      );
      assert.deepEqual(
        attachedFactIds(
          yield* recall("recall-after-supersede", "Add shard numbers to cache keys."),
        ),
        [],
      );
    }).pipe(
      Effect.provide(
        knowledgeTestLayer(
          Layer.succeed(HolographicMemory.HolographicMemory, {
            scoreCandidates: (input) =>
              Effect.succeed(
                input.candidates.map((candidate) => ({
                  id: candidate.id,
                  rawCosine: 1,
                  holographic: 1,
                  decay: 1,
                  reinforcement: 0,
                  score: 1,
                  scoreMillionths: 1_000_000,
                  tokenOverlap: 1,
                  fts: 1,
                  coverage: 1,
                })),
              ),
          }),
        ),
      ),
    ),
);

it.effect("recall does not score with the holographic kernel", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projectId = ProjectId.make("recall-no-kernel");
    yield* createProject(projectId);
    yield* knowledge.mutate(createFact(projectId), { kind: "user" });
    const query = "Do the cache keys carry tenant IDs?";
    const outcome = yield* knowledge.recall({
      projectId,
      threadId: ThreadId.make("recall-no-kernel"),
      requestId: CommandId.make("recall-no-kernel"),
      query,
      composer: { text: query, records: [] },
      knowledgeAllowance: 48000,
    });
    assert.deepEqual(attachedFactIds(outcome), [ProjectFactId.make("fact-one")]);
  }).pipe(
    Effect.provide(
      knowledgeTestLayer(
        Layer.succeed(HolographicMemory.HolographicMemory, {
          scoreCandidates: () => Effect.die("recall must not call HolographicMemory"),
        }),
      ),
    ),
  ),
);

it.effect("recall preserves trust order for equally covered eligible near-duplicates", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("recall-near-duplicates");
    yield* createProject(projectId);
    const duplicate = "Ship the ledger labs toggle for billing.";
    for (let index = 0; index < 40; index += 1) {
      const id = `dup-${index.toString().padStart(2, "0")}`;
      yield* knowledge.mutate(
        {
          ...createFact(projectId, id),
          content: duplicate,
          entities: [],
          tags: [],
        },
        { kind: "user" },
      );
    }
    yield* knowledge.mutate(
      {
        ...createFact(projectId, "current"),
        content: "The ledger labs toggle gates billing.",
        entities: ["ledger labs"],
        tags: [],
      },
      { kind: "user" },
    );
    for (let index = 0; index < 200; index += 1)
      yield* knowledge.mutate(
        {
          ...createFact(projectId, `pad-${index}`),
          content: `Unrelated padding subject ${index} about alphabets and gardens.`,
          entities: [],
          tags: [],
        },
        { kind: "user" },
      );
    yield* sql`UPDATE project_knowledge_facts SET trust = 0.9 WHERE project_id = ${projectId} AND id LIKE 'dup-%'`;
    yield* sql`UPDATE project_knowledge_facts SET trust = 0.51 WHERE project_id = ${projectId} AND id = 'current'`;
    const query = "Toggle ledger labs, then ship billing.";
    const outcome = yield* knowledge.recall({
      projectId,
      threadId: ThreadId.make("recall-near-duplicates"),
      requestId: CommandId.make("recall-near-duplicates"),
      query,
      composer: { text: query, records: [] },
      knowledgeAllowance: 48000,
    });
    assert.deepEqual(attachedFactIds(outcome), [
      ProjectFactId.make("dup-00"),
      ProjectFactId.make("dup-01"),
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "recall attaches an older fact when closer matches were shown or came from this thread",
  () =>
    Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const query = "Do the cache keys carry tenant IDs?";
      const longer = "Cache keys include tenant IDs. " + "background note ".repeat(40);
      const recallTarget = (projectId: ProjectId, threadId: ThreadId, requestId: string) =>
        knowledge.recall({
          projectId,
          threadId,
          requestId: CommandId.make(requestId),
          query,
          composer: { text: query, records: [] },
          knowledgeAllowance: 48000,
        });
      const saveOlderTarget = (projectId: ProjectId) => {
        const factId = ProjectFactId.make(`${projectId}-target`);
        return Effect.gen(function* () {
          yield* createProject(projectId);
          yield* knowledge.mutate(
            {
              ...createFact(projectId, factId),
              commandId: CommandId.make(`create:${factId}`),
              content: longer,
              entities: [],
            },
            { kind: "user" },
          );
          yield* TestClock.adjust("1 minute");
          return factId;
        });
      };

      const shownProject = ProjectId.make("recall-older-shown");
      const shownThread = ThreadId.make("recall-older-shown");
      const shownTarget = yield* saveOlderTarget(shownProject);
      const shownIds = Array.from({ length: 130 }, (_, index) =>
        ProjectFactId.make(`shown-${index.toString().padStart(2, "0")}`),
      );
      for (const factId of shownIds)
        yield* knowledge.mutate(
          { ...createFact(shownProject, factId), entities: [] },
          { kind: "user" },
        );
      yield* knowledge.recordViews(shownProject, shownThread, shownIds);
      assert.deepEqual(
        attachedFactIds(yield* recallTarget(shownProject, shownThread, "recall-older-shown")),
        [shownTarget],
      );

      const citedProject = ProjectId.make("recall-older-cited");
      const citedThread = ThreadId.make("recall-older-cited");
      const citedTarget = yield* saveOlderTarget(citedProject);
      yield* projections.apply(thread(citedThread, citedProject));
      yield* projections.apply(
        message(citedThread, "recall-older-cited-message", "user", "tenant IDs in keys"),
      );
      const source = yield* knowledge.readSource({
        projectId: citedProject,
        threadId: citedThread,
        messageId: MessageId.make("recall-older-cited-message"),
      });
      if (source.state !== "available") return yield* Effect.die("source unavailable");
      for (let index = 0; index < 130; index++)
        yield* knowledge.mutate(
          {
            ...createFact(citedProject, `cited-${index.toString().padStart(2, "0")}`),
            entities: [],
            sources: [source.source],
          },
          { kind: "user" },
        );
      assert.deepEqual(
        attachedFactIds(yield* recallTarget(citedProject, citedThread, "recall-older-cited")),
        [citedTarget],
      );

      const originProject = ProjectId.make("recall-older-origin");
      const originThread = ThreadId.make("recall-older-origin");
      const originTarget = yield* saveOlderTarget(originProject);
      const origin = {
        kind: "agent-thread" as const,
        threadId: originThread,
        providerInstanceId,
      };
      for (let index = 0; index < 130; index++)
        yield* knowledge.mutate(
          {
            ...createFact(originProject, `origin-${index.toString().padStart(2, "0")}`),
            entities: [],
            sources: [],
          },
          origin,
        );
      assert.deepEqual(
        attachedFactIds(yield* recallTarget(originProject, originThread, "recall-older-origin")),
        [originTarget],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("checks citations for one page of recall, not for every ranked fact", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectId = ProjectId.make("recall-citations");
    yield* createProject(projectId);
    const threadId = ThreadId.make("recall-citations-thread");
    yield* projections.apply(thread(threadId, projectId));
    yield* projections.apply(message(threadId, "recall-citation", "user", "tenant IDs in keys"));
    const source = yield* knowledge.readSource({
      projectId,
      threadId,
      messageId: MessageId.make("recall-citation"),
    });
    if (source.state !== "available") return yield* Effect.die("source unavailable");
    for (let index = 0; index < 100; index++)
      yield* knowledge.mutate(
        {
          ...createFact(projectId, `cited-${index}`),
          content: `Cache keys include tenant IDs, variant ${index}.`,
          sources: [source.source],
        },
        { kind: "user" },
      );
    let citationReads = 0;
    const countCitationReads: Statement.Transformer = (statement) => {
      const [query] = statement.compile();
      if (query.includes("orchestration_v2_projection_messages")) citationReads++;
      return Effect.succeed(statement);
    };
    const page = (requestId: string, factCursor?: { requestId: CommandId; offset: number }) =>
      knowledge
        .search({
          projectId,
          query: "tenant cache",
          requestId: CommandId.make(requestId),
          limit: 1,
          ...(factCursor ? { factCursor } : {}),
        })
        .pipe(Effect.provideService(Statement.CurrentTransformer, countCitationReads));
    const first = yield* page("recall-first");
    assert.isAtMost(citationReads, 3);
    if (first.facts.state !== "available") return assert.fail("ranking must be available");
    assert.equal(first.facts.matches.length, 1);
    assert.isNotNull(first.facts.nextCursor);
    const second = yield* page("recall-second", first.facts.nextCursor!);
    assert.equal(second.facts.state === "available" && second.facts.matches.length, 1);
    assert.notEqual(
      second.facts.state === "available" && second.facts.matches[0]?.fact.id,
      first.facts.matches[0]?.fact.id,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "MCP ranks canonical project facts through the native addon and records retrieval once",
  () =>
    Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projectId = ProjectId.make("native-mcp");
      const other = ProjectId.make("other-native-project");
      yield* createProject(projectId);
      yield* createProject(other);
      for (const id of ["b", "a", "c"])
        yield* knowledge.mutate(createFact(projectId, id), { kind: "user" });
      yield* knowledge.mutate(
        {
          ...createFact(projectId, "irrelevant"),
          content: "Use a small font.",
          entities: [],
          tags: [],
        },
        { kind: "user" },
      );
      yield* knowledge.mutate(createFact(other, "foreign"), { kind: "user" });
      const dependencies = Layer.mergeAll(
        Layer.succeed(ProjectKnowledge.ProjectKnowledge, knowledge),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "native-mcp",
          thread: undefined,
          client: { sessionId: "agent", label: "Agent", access: "read-only" },
          issuedAt: 0,
          capabilities: new Set(["orchestration" as const]),
        }),
      );
      const toolkit = yield* KnowledgeToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(KnowledgeHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const query = {
        projectId,
        query: "tenant cache",
        requestId: CommandId.make("native-search"),
        limit: 1,
      };
      const results = yield* toolkit
        .handle("t3_knowledge_search", query)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      const result = yield* decodeKnowledgeSearchResult(results.at(-1)?.result);
      if (result.facts.state !== "available")
        return assert.fail("Real native ranking must be available");
      assert.equal(result.facts.coverage, "complete");
      assert.equal(result.facts.matches[0]?.fact.id, "a");
      assert.isAbove(result.facts.matches[0]!.score.lexical, 0);
      assert.isAbove(result.facts.matches[0]!.score.holographic, 0);
      assert.equal(result.facts.matches[0]!.fact.retrievalCount, 1);
      const replay = yield* knowledge.search(query);
      assert.equal(
        replay.facts.state === "available" && replay.facts.matches[0]?.fact.retrievalCount,
        1,
      );
      assert.isNotNull(result.facts.nextCursor);
      const page = yield* knowledge.search({
        ...query,
        requestId: CommandId.make("native-page"),
        factCursor: result.facts.nextCursor!,
        limit: 10,
      });
      assert.deepEqual(
        page.facts.state === "available" && page.facts.matches.map((match) => match.fact.id),
        [ProjectFactId.make("b"), ProjectFactId.make("c")],
      );
      const wrongCursor = yield* knowledge
        .search({
          ...query,
          requestId: CommandId.make("wrong-cursor"),
          query: "different",
          factCursor: result.facts.nextCursor!,
        })
        .pipe(Effect.result);
      assert.equal(Result.isFailure(wrongCursor) && wrongCursor.failure.reason, "invalid_cursor");
      const reused = yield* knowledge.search({ ...query, query: "different" }).pipe(Effect.result);
      assert.equal(Result.isFailure(reused) && reused.failure.reason, "command_reused");
      const entity = yield* knowledge.search({
        ...query,
        requestId: CommandId.make("entities"),
        entities: ["TENANT", "cache"],
        entityMatch: "all",
      });
      assert.equal(entity.facts.state === "available" && entity.facts.matches.length, 1);
      yield* (yield* SqlClient.SqlClient)`UPDATE project_knowledge_facts SET trust = 0.2 WHERE id = 'a'`;
      const trust = yield* knowledge.search({
        ...query,
        requestId: CommandId.make("trust"),
        limit: 10,
      });
      assert.deepEqual(
        trust.facts.state === "available" && trust.facts.matches.map((match) => match.fact.id),
        [ProjectFactId.make("b"), ProjectFactId.make("c")],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("search receipts expire with their cursors and stay bounded in number", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("search-receipts");
    yield* createProject(projectId);
    yield* knowledge.mutate(createFact(projectId, "receipt-a"), { kind: "user" });
    yield* knowledge.mutate(createFact(projectId, "receipt-b"), { kind: "user" });
    const search = (requestId: string, factCursor?: { requestId: CommandId; offset: number }) =>
      knowledge.search({
        projectId,
        query: "tenant cache",
        requestId: CommandId.make(requestId),
        limit: 1,
        recordRetrieval: false,
        ...(factCursor ? { factCursor } : {}),
      });
    const first = yield* search("receipt-root");
    if (first.facts.state !== "available") return assert.fail("ranking must be available");
    const cursor = first.facts.nextCursor!;
    yield* TestClock.adjust("59 minutes");
    const page = yield* search("receipt-page", cursor);
    assert.equal(page.facts.state === "available" && page.facts.matches.length, 1);

    yield* TestClock.adjust("2 minutes");
    const expired = yield* search("receipt-late-page", cursor).pipe(Effect.result);
    assert.equal(Result.isFailure(expired) && expired.failure.reason, "invalid_cursor");

    for (let index = 0; index < 120; index++) yield* search(`receipt-browse-${index}`);
    const [stored] = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM project_knowledge_commands WHERE search_json IS NOT NULL`;
    assert.isAtMost(stored!.count, 100);
    // The newest browsing ranking still pages.
    const latest = yield* search("receipt-browse-latest");
    assert.isNotNull(latest.facts.state === "available" && latest.facts.nextCursor);
    const latestPage = yield* search(
      "receipt-browse-latest-page",
      latest.facts.state === "available" ? latest.facts.nextCursor! : cursor,
    );
    assert.equal(latestPage.facts.state === "available" && latestPage.facts.matches.length, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("traverses native rankings once despite unequal retrieval reinforcement", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("unequal-reinforcement");
    yield* createProject(projectId);
    for (const id of ["a", "b", "c", "d"])
      yield* knowledge.mutate(createFact(projectId, id), { kind: "user" });
    yield* sql`UPDATE project_knowledge_facts SET retrieval_count = 100, trust = 0.46 WHERE id = 'a'`;
    const query = { projectId, query: "tenant cache", limit: 2 };
    const firstInput = { ...query, requestId: CommandId.make("unequal-first") };
    const first = yield* knowledge.search(firstInput);
    if (first.facts.state !== "available") return assert.fail("Native ranking must be available");
    assert.deepEqual(
      first.facts.matches.map(({ fact }) => fact.id),
      ["a", "b"],
    );
    assert.equal(first.facts.matches[0]!.fact.retrievalCount, 101);
    assert.equal(first.facts.matches[1]!.fact.retrievalCount, 1);
    const seen = first.facts.matches.map(({ fact }) => fact.id);
    let cursor = first.facts.nextCursor;
    for (let page = 1; cursor !== null && page < 5; page++) {
      const input = { ...query, requestId: CommandId.make(`unequal-${page}`), factCursor: cursor };
      const next = yield* knowledge.search(input);
      if (next.facts.state !== "available") return assert.fail("Native ranking must be available");
      assert.deepEqual(
        next.facts.matches.filter(({ fact }) => seen.includes(fact.id)),
        [],
      );
      seen.push(...next.facts.matches.map(({ fact }) => fact.id));
      const replay = yield* knowledge.search(input);
      assert.deepEqual(replay, next);
      cursor = next.facts.nextCursor;
    }
    assert.isNull(cursor);
    assert.deepEqual(seen, ["a", "b", "c", "d"]);
    const replay = yield* knowledge.search(firstInput);
    assert.deepEqual(replay, first);
    const counts = yield* sql<{ id: string; count: number }>`
      SELECT id, retrieval_count AS count FROM project_knowledge_facts ORDER BY id`;
    assert.deepEqual(counts, [
      { id: "a", count: 101 },
      { id: "b", count: 1 },
      { id: "c", count: 1 },
      { id: "d", count: 1 },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("pages conversations without reranking or reinforcing the current fact page", () =>
  Effect.gen(function* () {
    let scoreCalls = 0;
    const scoring = Layer.effect(
      HolographicMemory.HolographicMemory,
      Effect.gen(function* () {
        const native = yield* HolographicMemory.HolographicMemory;
        return HolographicMemory.HolographicMemory.of({
          scoreCandidates: (input) => {
            scoreCalls += 1;
            return native.scoreCandidates(input);
          },
        });
      }),
    ).pipe(Layer.provide(HolographicMemory.layer));
    yield* Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const projectId = ProjectId.make("independent-paging");
      const other = ProjectId.make("other-paging");
      yield* createProject(projectId);
      yield* createProject(other);
      for (const id of ["a", "b", "c"]) {
        const threadId = ThreadId.make(`conversation-${id}`);
        yield* projections.apply(thread(threadId, projectId));
        yield* projections.apply(message(threadId, `message-${id}`, "user", "tenant cache"));
        yield* knowledge.mutate(createFact(projectId, id), { kind: "user" });
      }
      const input = {
        projectId,
        query: "tenant cache",
        limit: 1,
        requestId: CommandId.make("independent-first"),
      };
      const first = yield* knowledge.search(input);
      if (first.facts.state !== "available" || first.messages.nextCursor == null)
        return assert.fail("Both searches must have another page");
      const nextInput = { ...input, cursor: first.messages.nextCursor };
      const messages = yield* knowledge.search(nextInput);
      assert.deepEqual(messages.facts, first.facts);
      assert.notEqual(messages.messages.matches[0]?.threadId, first.messages.matches[0]?.threadId);
      const facts = yield* knowledge.search({
        ...nextInput,
        requestId: CommandId.make("independent-facts"),
        factCursor: first.facts.nextCursor!,
      });
      assert.deepEqual(facts.messages, messages.messages);
      assert.deepEqual(
        facts.facts.state === "available" && facts.facts.matches.map(({ fact }) => fact.id),
        [ProjectFactId.make("b")],
      );
      assert.equal(scoreCalls, 1);
      for (const change of [
        { query: "different" },
        { projectId: other },
        { includeArchived: true },
        { minTrust: 0.4 },
        { entities: ["tenant"] },
      ]) {
        const reused = yield* knowledge.search({ ...input, ...change }).pipe(Effect.result);
        assert.equal(Result.isFailure(reused) && reused.failure.reason, "command_reused");
        const mismatch = yield* knowledge
          .search({
            ...input,
            ...change,
            requestId: CommandId.make(`mismatch-${JSON.stringify(change)}`),
            factCursor: first.facts.nextCursor!,
          })
          .pipe(Effect.result);
        assert.equal(Result.isFailure(mismatch) && mismatch.failure.reason, "invalid_cursor");
      }
    }).pipe(Effect.provide(knowledgeTestLayer(scoring)));
  }),
);

it.effect.each(["edit", "forget", "source"] as const)(
  "omits a %s change from continuation and replay",
  (action) =>
    Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const projectId = ProjectId.make(`page-${action}`);
      const threadId = ThreadId.make(`source-${action}`);
      yield* createProject(projectId);
      yield* projections.apply(thread(threadId, projectId));
      yield* projections.apply(message(threadId, "source-message", "user", "tenant cache"));
      const source = yield* knowledge.readSource({
        projectId,
        threadId,
        messageId: MessageId.make("source-message"),
      });
      if (source.state !== "available") return assert.fail("Source must be available");
      for (const id of ["a", "b", "c"])
        yield* knowledge.mutate(
          { ...createFact(projectId, id), sources: [source.source] },
          { kind: "user" },
        );
      const input = {
        projectId,
        query: "tenant cache",
        limit: 1,
        requestId: CommandId.make(`before-${action}`),
      };
      const first = yield* knowledge.search(input);
      if (first.facts.state !== "available" || !first.facts.nextCursor)
        return assert.fail("Facts must have another page");
      if (action === "source") {
        yield* projections.apply(
          message(threadId, "source-message", "user", "Changed source", { minute: 2 }),
        );
      } else {
        for (const id of ["a", "b"])
          yield* knowledge.mutate(
            action === "forget"
              ? {
                  action,
                  commandId: CommandId.make(`forget-${id}`),
                  projectId,
                  factId: ProjectFactId.make(id),
                  expectedRevision: 1,
                }
              : {
                  ...createFact(projectId, id),
                  action,
                  commandId: CommandId.make(`edit-${id}`),
                  expectedRevision: 1,
                  content: "Revised decision",
                },
            { kind: "user" },
          );
      }
      const page = yield* knowledge.search({
        ...input,
        requestId: CommandId.make(`after-${action}`),
        factCursor: first.facts.nextCursor,
      });
      assert.deepEqual(
        page.facts.state === "available" && page.facts.matches.map(({ fact }) => fact.id),
        action === "source" ? [] : [ProjectFactId.make("c")],
      );
      assert.isNull(page.facts.state === "available" && page.facts.nextCursor);
      const replay = yield* knowledge.search(input);
      assert.deepEqual(replay.facts.state === "available" && replay.facts.matches, []);
      const sql = yield* SqlClient.SqlClient;
      const untouched = yield* sql<{
        count: number;
      }>`SELECT retrieval_count AS count FROM project_knowledge_facts WHERE id = 'b'`;
      assert.equal(untouched[0]?.count, 0);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["edit", "forget", "cancel"] as const)(
  "does not publish stale knowledge or false retrieval telemetry after %s during scoring",
  (action) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const scoring = Layer.effect(
        HolographicMemory.HolographicMemory,
        Effect.gen(function* () {
          const native = yield* HolographicMemory.HolographicMemory;
          return HolographicMemory.HolographicMemory.of({
            scoreCandidates: (input) =>
              native.scoreCandidates(input).pipe(
                Effect.tap(() => Deferred.succeed(entered, undefined)),
                Effect.tap(() => Deferred.await(release)),
              ),
          });
        }),
      ).pipe(Layer.provide(HolographicMemory.layer));
      yield* Effect.gen(function* () {
        const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make(`scoring-${action}`);
        yield* createProject(projectId);
        const fact = yield* knowledge.mutate(createFact(projectId), { kind: "user" });
        const requestId = CommandId.make(`search-${action}`);
        const fiber = yield* knowledge
          .search({ projectId, query: "tenant cache", requestId })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        if (action === "cancel") {
          yield* Fiber.interrupt(fiber);
        } else {
          yield* knowledge.mutate(
            action === "forget"
              ? {
                  action,
                  commandId: CommandId.make(action),
                  projectId,
                  factId: fact.id,
                  expectedRevision: 1,
                }
              : {
                  ...createFact(projectId),
                  action,
                  commandId: CommandId.make(action),
                  expectedRevision: 1,
                  content: "Region keys replaced tenant keys.",
                },
            { kind: "user" },
          );
          yield* Deferred.succeed(release, undefined);
          const result = yield* Fiber.join(fiber);
          assert.deepEqual(result.facts.state === "available" && result.facts.matches, []);
        }
        const rows = yield* sql<{
          retrieval_count: number;
        }>`SELECT retrieval_count FROM project_knowledge_facts WHERE id = ${fact.id}`;
        assert.equal(rows[0]?.retrieval_count, 0);
        if (action === "cancel")
          assert.deepEqual(
            yield* sql`SELECT command_id FROM project_knowledge_commands WHERE command_id = ${requestId}`,
            [],
          );
      }).pipe(Effect.provide(knowledgeTestLayer(scoring)));
    }),
);

it.effect("does not expose facts for a deleted project", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projectId = ProjectId.make("deleted-project");
    yield* createProject(projectId);
    yield* knowledge.mutate(createFact(projectId), { kind: "user" });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE projection_projects SET deleted_at = '2026-10-22T00:00:00.000Z' WHERE project_id = ${projectId}`;
    const result = yield* knowledge.list({ projectId }).pipe(Effect.result);
    assert.equal(Result.isFailure(result) && result.failure.reason, "missing_project");
  }).pipe(Effect.provide(layerTest)),
);

const existing = (fact: { readonly id: ProjectFactId; readonly revision: number }, id: string) => ({
  commandId: CommandId.make(id),
  projectId: ProjectId.make("history"),
  factId: fact.id,
  expectedRevision: fact.revision,
});

it.effect("records every lifecycle event in order and erases bodies when forgotten", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projectId = ProjectId.make("history");
    yield* createProject(projectId);
    const agent = { kind: "agent-client", sessionId: "agent", label: "Agent" } as const;
    const created = yield* knowledge.mutate({ ...createFact(projectId), sources: [] }, agent);
    const edited = yield* knowledge.mutate(
      {
        ...existing(created, "history-edit"),
        action: "edit",
        content: "Cache keys include tenant and region IDs.",
        entities: ["cache"],
        tags: [],
        kind: "decision",
        sources: [],
      },
      agent,
    );
    const helpful = yield* knowledge.mutate(
      { ...existing(edited, "history-up"), action: "feedback", helpful: true },
      { kind: "user" },
    );
    const unhelpful = yield* knowledge.mutate(
      { ...existing(helpful, "history-down"), action: "feedback", helpful: false },
      { kind: "user" },
    );
    const offTask = yield* knowledge.mutate(
      { ...existing(unhelpful, "history-off-task"), action: "feedback", helpful: "irrelevant" },
      agent,
    );
    const detail = yield* knowledge.readFact({ projectId, factId: created.id });
    assert.deepEqual(
      detail.history.map((entry) => [entry.event, entry.revision, entry.helpful]),
      [
        ["created", 1, null],
        ["edited", 2, null],
        ["feedback", 3, true],
        ["feedback", 4, false],
        ["feedback", 5, false],
      ],
    );
    assert.equal(detail.history.at(-1)?.feedbackScope, "task");
    assert.equal(detail.history.at(-1)?.reason, "Unrelated to this task.");
    assert.deepEqual(detail.history[0]?.actor, agent);
    assert.equal(detail.history[1]?.content, "Cache keys include tenant and region IDs.");
    assert.match(detail.history[1]?.contentDigest ?? "", /^[a-f0-9]{64}$/);
    assert.notEqual(detail.history[0]?.contentDigest, detail.history[1]?.contentDigest);
    assert.deepEqual(
      detail.history.slice(2).map((entry) => [entry.trustBefore, entry.trustAfter]),
      [
        [0.5, 0.55],
        [0.55, unhelpful.trust],
        [unhelpful.trust, offTask.trust],
      ],
    );
    assert.isFalse(detail.historyTruncated);

    yield* knowledge.mutate(
      { ...existing(offTask, "history-forget"), action: "forget" },
      { kind: "user" },
    );
    const forgotten = yield* knowledge.readFact({ projectId, factId: created.id });
    assert.equal(forgotten.history.at(-1)?.event, "forgotten");
    assert.deepEqual(
      forgotten.history.filter((entry) => entry.content !== null || entry.sources.length > 0),
      [],
    );
    assert.equal(forgotten.history[1]?.contentDigest, detail.history[1]?.contentDigest);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("supersedes a fact by linking both ways and dropping the old one from recall", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projectId = ProjectId.make("history");
    yield* createProject(projectId);
    const old = yield* knowledge.mutate(
      { ...createFact(projectId, "npm"), content: "The workspace uses npm for package installs." },
      { kind: "user" },
    );
    const replacement = yield* knowledge.mutateWithHints(
      {
        ...existing(old, "supersede-npm"),
        action: "supersede",
        replacementFactId: ProjectFactId.make("pnpm"),
        content: "The workspace uses pnpm for package installs.",
        entities: [],
        tags: [],
        kind: "decision",
        sources: [{ kind: "user" }],
      },
      { kind: "user" },
    );
    assert.equal(replacement.supersedes, old.id);
    assert.deepEqual(replacement.hints, []);
    const before = yield* knowledge.readFact({ projectId, factId: old.id });
    assert.equal(before.fact.supersededBy, replacement.id);
    assert.equal(before.fact.content, "The workspace uses npm for package installs.");
    assert.equal(before.fact.status, "saved");
    assert.equal(before.supersededBy?.id, replacement.id);
    assert.equal(before.history.at(-1)?.event, "superseded");
    assert.equal(
      (yield* knowledge.readFact({ projectId, factId: replacement.id })).supersedes?.id,
      old.id,
    );

    assert.deepEqual(
      (yield* knowledge.list({ projectId })).facts.map((fact) => fact.id),
      [replacement.id],
    );
    assert.deepEqual(
      (yield* knowledge.list({ projectId, includeSuperseded: true })).facts.map((fact) => fact.id),
      [old.id, replacement.id],
    );
    const recalled = (includeSuperseded: boolean) =>
      knowledge
        .search({
          projectId,
          query: "workspace package installs",
          requestId: CommandId.make(`recall-superseded:${includeSuperseded}`),
          includeSuperseded,
        })
        .pipe(
          Effect.map((result) =>
            result.facts.state === "available"
              ? result.facts.matches.map((match) => match.fact.id).sort()
              : [],
          ),
        );
    assert.deepEqual(yield* recalled(false), [replacement.id]);
    assert.deepEqual(yield* recalled(true), [old.id, replacement.id]);

    const edit = yield* knowledge
      .mutate(
        {
          ...existing(before.fact, "edit-superseded"),
          action: "edit",
          content: "Edited.",
          entities: [],
          tags: [],
          kind: "note",
          sources: [{ kind: "user" }],
        },
        { kind: "user" },
      )
      .pipe(Effect.result);
    assert.equal(Result.isFailure(edit) && edit.failure.reason, "superseded");
    const restored = yield* knowledge.mutate(
      {
        ...existing(before.fact, "restore-prior-memory"),
        action: "restore",
      },
      { kind: "user" },
    );
    assert.isNull(restored.supersededBy);
    const unlinked = yield* knowledge.readFact({ projectId, factId: replacement.id });
    assert.isNull(unlinked.fact.supersedes);
    assert.isNull(unlinked.supersedes);
    assert.equal(unlinked.fact.revision, replacement.revision + 1);
    assert.equal(unlinked.history.at(-1)?.event, "edited");
    assert.equal(unlinked.history.at(-1)?.relatedFactId, old.id);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("hints at a contradicting near duplicate but not at unrelated facts", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projectId = ProjectId.make("history");
    yield* createProject(projectId);
    const redis = yield* knowledge.mutate(
      { ...createFact(projectId, "redis"), content: "We use Redis for session caching." },
      { kind: "user" },
    );
    yield* knowledge.mutate(
      { ...createFact(projectId, "deploys"), content: "Deploys run from the release branch." },
      { kind: "user" },
    );
    const conflicting = yield* knowledge.mutateWithHints(
      {
        ...createFact(projectId, "no-redis"),
        content: "We no longer use Redis for session caching.",
      },
      { kind: "user" },
    );
    assert.deepEqual(
      conflicting.hints?.map((hint) => [hint.kind, hint.factId]),
      [["possible_conflict", redis.id]],
    );
    const unrelated = yield* knowledge.mutateWithHints(
      { ...createFact(projectId, "fonts"), content: "Marketing pages self-host their fonts." },
      { kind: "user" },
    );
    assert.deepEqual(unrelated.hints, []);
    assert.deepEqual(
      (yield* knowledge.readFact({ projectId, factId: redis.id })).hints.map((hint) => hint.factId),
      [conflicting.id],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("summarizes memory health by status, trust, feedback and lost sources", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectId = ProjectId.make("history");
    const threadId = ThreadId.make("health-thread");
    const messageId = MessageId.make("health-message");
    yield* createProject(projectId);
    yield* projections.apply(thread(threadId, projectId));
    yield* projections.apply(message(threadId, messageId, "user", "Pin Node to 22."));
    const source = yield* knowledge.readSource({ projectId, threadId, messageId });
    if (source.state !== "available") return assert.fail("source should be available");
    const cited = yield* knowledge.mutate(
      { ...createFact(projectId, "cited"), sources: [source.source] },
      { kind: "user" },
    );
    const agentFact = yield* knowledge.mutate(
      { ...createFact(projectId, "agent-fact"), sources: [] },
      {
        kind: "agent-client",
        sessionId: "agent",
        label: "Agent",
      },
    );
    let distrusted = yield* knowledge.mutate(createFact(projectId, "distrusted"), {
      kind: "user",
    });
    for (const step of [1, 2, 3])
      distrusted = yield* knowledge.mutate(
        { ...existing(distrusted, `distrust-${step}`), action: "feedback", helpful: false },
        { kind: "user" },
      );
    yield* knowledge.mutate(
      { ...existing(agentFact, "praise"), action: "feedback", helpful: true },
      { kind: "user" },
    );
    yield* knowledge.mutate(
      { ...existing(distrusted, "off-task"), action: "feedback", helpful: "irrelevant" },
      { kind: "user" },
    );
    const forgotten = yield* knowledge.mutate(createFact(projectId, "forgotten"), {
      kind: "user",
    });
    yield* knowledge.mutate(
      { ...existing(forgotten, "forget-health"), action: "forget" },
      { kind: "user" },
    );
    const old = yield* knowledge.mutate(createFact(projectId, "old"), { kind: "user" });
    yield* knowledge.mutate(
      {
        ...existing(old, "supersede-health"),
        action: "supersede",
        replacementFactId: ProjectFactId.make("new"),
        content: "Replacement fact.",
        entities: [],
        tags: [],
        kind: "note",
        sources: [{ kind: "user" }],
      },
      { kind: "user" },
    );
    yield* projections.apply(
      message(threadId, messageId, "user", "Pin Node to 24.", { minute: 3 }),
    );

    const sql = yield* SqlClient.SqlClient;
    for (const [verdict, trust] of [
      ["standing", 0.5],
      ["task", 0.5],
      ["code", 0.2],
    ] as const) {
      const fact = yield* knowledge.mutate(createFact(projectId, `health-${verdict}`), {
        kind: "user",
      });
      yield* sql`UPDATE project_knowledge_facts
        SET verdict = ${verdict}, verdict_by = 'check', verdict_at = ${fact.createdAt}, trust = ${trust}
        WHERE id = ${fact.id}`;
    }

    const status = yield* knowledge.status({ projectId });
    assert.deepEqual(status.counts, { saved: 7, superseded: 1, forgotten: 1 });
    assert.deepEqual(status.trustBands, { low: 1, guarded: 0, steady: 4, high: 0 });
    assert.equal(status.belowRecallThreshold, 1);
    assert.deepEqual(status.feedback, { helpful: 1, unhelpful: 3, irrelevant: 1 });
    assert.equal(status.unavailableSources, 1);
    assert.equal(status.unavailableSourcesCoverage, "complete");
    assert.deepEqual(
      (yield* knowledge.list({ projectId, sourceState: "unavailable" })).facts.map(
        (fact) => fact.id,
      ),
      [cited.id],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("bounds message matches independently of fact pages without recording retrieval", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectId = ProjectId.make("separate-search-limits");
    yield* createProject(projectId);
    for (const id of ["a", "b", "c"]) {
      const threadId = ThreadId.make("limited-" + id);
      yield* projections.apply(thread(threadId, projectId));
      yield* projections.apply(message(threadId, "limited-message-" + id, "user", "tenant cache"));
      yield* knowledge.mutate(createFact(projectId, id), { kind: "user" });
    }
    const input = {
      projectId,
      query: "tenant cache",
      requestId: CommandId.make("limited-first"),
      limit: 2,
      messageLimit: 1,
      recordRetrieval: false,
    };
    const first = yield* knowledge.search(input);
    if (first.facts.state !== "available") return assert.fail("Native ranking must be available");
    assert.equal(first.messages.matches.length, 1);
    assert.equal(first.facts.matches.length, 2);
    assert.isNotNull(first.facts.nextCursor);
    const second = yield* knowledge.search({
      ...input,
      requestId: CommandId.make("limited-second"),
      factCursor: first.facts.nextCursor!,
    });
    if (second.facts.state !== "available") return assert.fail("Native ranking must be available");
    assert.equal(second.messages.matches.length, 1);
    assert.equal(second.facts.matches.length, 1);
    assert.isNull(second.facts.nextCursor);
    const sql = yield* SqlClient.SqlClient;
    const counts = yield* sql<{
      count: number;
    }>`SELECT retrieval_count AS count FROM project_knowledge_facts`;
    assert.deepEqual(
      counts.map(({ count }) => count),
      [0, 0, 0],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "keeps a prepared native delivery decodable across SQLite restart and persists its uncertain recovery",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const database = SqlitePersistence.layerFromPath(directory + "/delivery.sqlite");
      const reopened = () =>
        ProjectKnowledge.layer.pipe(
          Layer.provide(HolographicMemory.layer),
          Layer.provideMerge(
            Layer.mergeAll(ProjectStore.layer, ProjectionStore.layer, ThreadSearch.layer),
          ),
          Layer.provideMerge(database),
          Layer.provide(
            Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(environmentId),
            }),
          ),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        );
      const projectId = ProjectId.make("restart-delivery-project");
      const threadId = ThreadId.make("restart-delivery-thread");
      const messageId = MessageId.make("restart-delivery-message");
      const receipt = {
        projectId,
        threadId,
        messageId,
        attemptId: RunAttemptId.make("restart-attempt"),
        runId: RunId.make("restart-run"),
        providerInstanceId,
        providerThreadId: ProviderThreadId.make("restart-provider-thread"),
        nativeThreadId: "restart-native-conversation",
        status: "prepared" as const,
        budget: {
          estimatedTokens: 777,
          capacity: 128000,
          occupancy: 1000,
          requestSize: 200,
          headroom: 32000,
          knowledgeAllowance: 16000,
          tokenCap: 16000,
          byteCap: 64000,
        },
        items: [],
        omissions: [],
        createdAt: DateTime.formatIso(at(1)),
        updatedAt: DateTime.formatIso(at(1)),
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* createProject(projectId);
          yield* (yield* ProjectKnowledge.ProjectKnowledge).recordDelivery(receipt);
        }).pipe(Effect.provide(reopened())),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
          const persisted = (yield* knowledge.readDeliveries({ projectId, threadId, messageId }))
            .deliveries[0]!;
          assert.deepEqual(persisted.budget, receipt.budget);
          assert.equal(persisted.status, "prepared");
          assert.equal(persisted.nativeThreadId, receipt.nativeThreadId);
          assert.equal(persisted.providerThreadId, receipt.providerThreadId);
          yield* knowledge.recordDelivery({
            ...persisted,
            status: "uncertain",
            updatedAt: DateTime.formatIso(at(2)),
          });
        }).pipe(Effect.provide(reopened())),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
          const persisted = (yield* knowledge.readDeliveries({ projectId, threadId, messageId }))
            .deliveries;
          assert.equal(persisted.length, 1);
          assert.equal(persisted[0]?.status, "uncertain");
          assert.equal(persisted[0]?.nativeThreadId, receipt.nativeThreadId);
          yield* knowledge.recordDelivery({ ...persisted[0]!, status: "sent" });
        }).pipe(Effect.provide(reopened())),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
          assert.equal(yield* knowledge.nativeDeliveryEstimate(receipt), 777);
        }).pipe(Effect.provide(reopened())),
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("automatic corroboration appends validated sources without rewriting curated facts", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectId = ProjectId.make("corroboration");
    const threadId = ThreadId.make("corroboration-thread");
    yield* createProject(projectId);
    yield* projections.apply(thread(threadId, projectId));
    yield* projections.apply(
      message(threadId, "corroboration-source", "user", "Cache keys include tenant IDs."),
    );
    const citation = yield* knowledge.readSource({
      projectId,
      threadId,
      messageId: MessageId.make("corroboration-source"),
    });
    assert.equal(citation.state, "available");
    if (citation.state !== "available") return;
    const original = yield* knowledge.mutate(createFact(projectId), { kind: "user" });
    const actor = {
      kind: "assisted" as const,
      threadId,
      runId: RunId.make("corroboration-run"),
      runOutcome: "completed" as const,
    };
    const candidate = { ...createFact(projectId, "automatic"), sources: [citation.source] };
    assert.equal((yield* knowledge.saveAutomatic(candidate, actor)).outcome, "duplicate");
    const merged = (yield* knowledge.readFact({ projectId, factId: original.id })).fact;
    // A verdict is written once: a duplicate's check does not reclassify the fact it joins.
    assert.isUndefined(merged.verdict);
    assert.deepEqual(merged.sources, [...original.sources, citation.source]);
    assert.equal(merged.content, original.content);
    assert.deepEqual(merged.origin, original.origin);
    assert.equal(merged.trust, original.trust);
    yield* knowledge.saveAutomatic(
      { ...candidate, factId: ProjectFactId.make("automatic-repeat") },
      actor,
    );
    assert.deepEqual((yield* knowledge.readFact({ projectId, factId: original.id })).fact, merged);
    const invalid = yield* knowledge
      .saveAutomatic(
        {
          ...candidate,
          factId: ProjectFactId.make("automatic-invalid"),
          sources: [{ ...citation.source, runId: RunId.make("fabricated") }],
        },
        actor,
      )
      .pipe(Effect.result);
    assert.equal(invalid._tag, "Failure");
    const extraSources = [];
    for (let index = 0; index < 16; index++) {
      const id = MessageId.make(`corroboration-extra-${index}`);
      yield* projections.apply(message(threadId, id, "user", "Cache keys include tenant IDs."));
      const source = yield* knowledge.readSource({ projectId, threadId, messageId: id });
      if (source.state === "available") extraSources.push(source.source);
    }
    yield* knowledge.saveAutomatic(
      { ...candidate, factId: ProjectFactId.make("automatic-cap"), sources: extraSources },
      actor,
    );
    const capped = (yield* knowledge.readFact({ projectId, factId: original.id })).fact;
    assert.equal(capped.sources.length, 16);
    assert.deepEqual(capped.sources.slice(0, 2), merged.sources);
    yield* knowledge.mutate(
      {
        action: "forget",
        projectId,
        factId: original.id,
        expectedRevision: capped.revision,
        commandId: CommandId.make("forget-corroborated"),
      },
      { kind: "user" },
    );
    yield* knowledge.saveAutomatic({ ...candidate, factId: original.id }, actor);
    assert.equal(
      (yield* knowledge.readFact({ projectId, factId: original.id })).fact.status,
      "forgotten",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "returns a timed-out outcome when a recall store read is still open after one second",
  () =>
    Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projectId = ProjectId.make("recall-timeout");
      yield* createProject(projectId);
      yield* knowledge.mutate(createFact(projectId), { kind: "user" });
      const blocked = yield* Deferred.make<void>();
      const stall: Statement.Transformer = (statement) =>
        Deferred.await(blocked).pipe(Effect.as(statement));
      const query = "Do the cache keys carry tenant IDs?";
      const pending = yield* knowledge
        .recall({
          projectId,
          threadId: ThreadId.make("recall-timeout"),
          requestId: CommandId.make("recall-timeout"),
          query,
          composer: { text: query, records: [] },
          knowledgeAllowance: 48000,
        })
        .pipe(Effect.provideService(Statement.CurrentTransformer, stall), Effect.forkChild);
      yield* TestClock.adjust("999 millis");
      assert.isUndefined(pending.pollUnsafe());
      yield* TestClock.adjust("1 millis");
      assert.deepEqual(yield* Fiber.join(pending), {
        _tag: "Omitted",
        reason: "timed_out",
      });
    }).pipe(Effect.provide(layerTest)),
);

it.effect("does not consider a newer fact that shares no term with the recall query", () => {
  const scoring = Layer.succeed(HolographicMemory.HolographicMemory, {
    scoreCandidates: (input) =>
      Effect.sync(() =>
        input.candidates.map((candidate) => ({
          id: candidate.id,
          rawCosine: 1,
          holographic: 1,
          decay: 1,
          reinforcement: 0,
          score: 1,
          scoreMillionths: 1_000_000,
          tokenOverlap: 1,
          fts: 1,
          coverage: 1,
        })),
      ),
  });
  return Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("recall-bounded");
    yield* createProject(projectId);
    yield* knowledge.mutate(createFact(projectId, "matching"), { kind: "user" });
    yield* TestClock.adjust("1 minute");
    yield* knowledge.mutate(
      {
        ...createFact(projectId, "newer-unrelated"),
        content: "Zephyr quilting marmalade weekday.",
        entities: [],
        tags: [],
      },
      { kind: "user" },
    );
    const query = "Do the cache keys carry tenant IDs?";
    const outcome = yield* knowledge.recall({
      projectId,
      threadId: ThreadId.make("recall-bounded"),
      requestId: CommandId.make("recall-bounded"),
      query,
      composer: { text: query, records: [] },
      knowledgeAllowance: 48000,
    });
    const considered =
      outcome._tag === "Omitted" ? [] : (outcome.top ?? []).map((item) => item.factId);
    assert.include(considered, "matching");
    assert.notInclude(considered, "newer-unrelated");
    const searched = yield* knowledge.search({
      projectId,
      query,
      requestId: CommandId.make("search-bounded"),
    });
    assert.equal(searched.facts.state, "available");
    if (searched.facts.state !== "available") return;
    assert.include(
      searched.facts.matches.map((match) => match.fact.id),
      ProjectFactId.make("newer-unrelated"),
    );
    assert.deepEqual(
      yield* sql`SELECT id FROM project_knowledge_facts WHERE id = 'newer-unrelated' AND updated_at > (SELECT updated_at FROM project_knowledge_facts WHERE id = 'matching')`,
      [{ id: "newer-unrelated" }],
    );
  }).pipe(Effect.provide(knowledgeTestLayer(scoring)));
});

it.effect("reads the recall lookup on the reader connection", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-recall-reader-" });
    const layerFile = ProjectKnowledge.layer.pipe(
      Layer.provide(HolographicMemory.layer),
      Layer.provideMerge(
        Layer.mergeAll(ProjectStore.layer, ProjectionStore.layer, ThreadSearch.layer),
      ),
      Layer.provideMerge(SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite"))),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
    const spans: Array<Tracer.Span> = [];
    const observe: Statement.Transformer = (statement, _sql, _fiber, span) => {
      spans.push(span);
      return Effect.succeed(statement);
    };
    yield* Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projectId = ProjectId.make("recall-reader");
      yield* createProject(projectId);
      yield* knowledge.mutate(createFact(projectId), { kind: "user" });
      const query = "Do the cache keys carry tenant IDs?";
      yield* knowledge
        .recall({
          projectId,
          threadId: ThreadId.make("recall-reader"),
          requestId: CommandId.make("recall-reader"),
          query,
          composer: { text: query, records: [] },
          knowledgeAllowance: 48000,
        })
        .pipe(
          Effect.withTracerEnabled(true),
          Effect.provideService(Statement.CurrentTransformer, observe),
          Effect.provideService(Statement.SpanPropagationEnabled, true),
        );
      const connectionOf = (span: Tracer.Span): unknown => {
        const own = span.attributes.get("db.connection");
        if (typeof own === "string") return own;
        const parent = span.parent._tag === "Some" ? span.parent.value : undefined;
        return parent?._tag === "Span" ? connectionOf(parent) : own;
      };
      const connections = spans.map((span) => {
        const parent = span.parent._tag === "Some" ? span.parent.value : undefined;
        return {
          name: parent?._tag === "Span" ? parent.name : span.name,
          connection: connectionOf(span),
        };
      });
      assert.isAbove(connections.length, 0);
      assert.isTrue(
        connections.every((span) => span.connection === "reader"),
        JSON.stringify(connections),
      );
      for (const name of [
        "ProjectKnowledgeStore.seenFactIds",
        "ProjectKnowledgeStore.recallCandidates",
        "ProjectKnowledgeStore.find",
      ])
        assert.isTrue(
          connections.some((span) => span.name === name),
          JSON.stringify(connections),
        );
    }).pipe(Effect.provide(layerFile));
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "recall selects two related facts without searching transcripts or recording retrieval",
  () =>
    Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projectId = ProjectId.make("bounded-recall");
      const query = "cache keys tenant";
      yield* createProject(projectId);
      const recall = (requestId: string) =>
        knowledge
          .recall({
            projectId,
            threadId: ThreadId.make("recall-thread"),
            requestId: CommandId.make(requestId),
            query,
            composer: { text: query, records: [] },
            knowledgeAllowance: 48000,
          })
          .pipe(Effect.map(attachedComposer));
      assert.isNull(yield* recall("recall-empty"));
      for (const id of ["first", "second", "third"])
        yield* knowledge.mutate(createFact(projectId, id), { kind: "user" });
      yield* knowledge.mutate(
        {
          ...createFact(projectId, "unrelated"),
          content: "Use readable garden labels.",
          entities: [],
          tags: [],
        },
        { kind: "user" },
      );
      const result = yield* recall("recall-related");
      const record = result?.records[0];
      assert.equal(record?.kind, "project-knowledge");
      if (record?.kind !== "project-knowledge" || !("knowledge" in record)) return;
      assert.equal(record.knowledge.selections.length, 2);
      assert.isFalse(
        record.knowledge.selections.some(
          (selection) => selection.kind === "fact" && selection.factId === "unrelated",
        ),
      );
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql`SELECT command_id FROM project_knowledge_commands WHERE search_json IS NOT NULL`)
          .length,
        0,
      );
      assert.deepEqual(
        yield* sql`SELECT id FROM project_knowledge_facts WHERE project_id = ${projectId} AND retrieval_count > 0`,
        [],
      );
    }).pipe(Effect.provide(knowledgeTestLayer(HolographicMemory.layer, true))),
);

const isolatedFact = (
  projectId: ProjectId,
  id: string,
  content: string,
): ProjectKnowledgeMutation => ({
  ...createFact(projectId, id),
  content,
  entities: [],
  tags: [],
});
const recallIdsFor = (
  knowledge: ProjectKnowledge.ProjectKnowledge["Service"],
  projectId: ProjectId,
  query: string,
  request: string,
) =>
  knowledge
    .recall({
      projectId,
      threadId: ThreadId.make(request),
      requestId: CommandId.make(request),
      query,
      composer: { text: query, records: [] },
      knowledgeAllowance: 48000,
    })
    .pipe(Effect.map(attachedFactIds));
it.effect("recall in one project depends on facts saved in other projects", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const seed = (projectId: ProjectId) =>
      Effect.gen(function* () {
        yield* createProject(projectId);
        yield* knowledge.mutate(
          isolatedFact(
            projectId,
            `${projectId}-target`,
            "React component props must be memoized before passing callbacks to list rows.",
          ),
          { kind: "user" },
        );
        for (let i = 0; i < 20; i++)
          yield* knowledge.mutate(
            isolatedFact(
              projectId,
              `${projectId}-pad-${i}`,
              `Deploy note ${i}: rotate gardens alphabet.`,
            ),
            { kind: "user" },
          );
      });
    const query =
      "Why does the list row rerender? Check whether React component props callbacks are memoized.";
    const alone = ProjectId.make("op-alone");
    yield* seed(alone);
    const before = yield* recallIdsFor(knowledge, alone, query, "alone-before");
    // Another project on the same server saves many React notes.
    const other = ProjectId.make("op-other-web-app");
    yield* createProject(other);
    for (let i = 0; i < 400; i++)
      yield* knowledge.mutate(
        isolatedFact(
          other,
          `other-${i}`,
          `React component ${i} props callbacks list rows memoized rerender check ${i}.`,
        ),
        { kind: "user" },
      );
    const after = yield* recallIdsFor(knowledge, alone, query, "alone-after");
    assert.deepEqual(before, [ProjectFactId.make("op-alone-target")]);
    assert.deepEqual(after, before);
    const tiedProject = ProjectId.make("isolated-ties");
    yield* createProject(tiedProject);
    const contents = ["cobalt kestrel lantern", "orchard harbor willow", "violet copper quartz"];
    for (const [index, content] of contents.entries())
      yield* knowledge.mutate(isolatedFact(tiedProject, `tie-${index}`, content), { kind: "user" });
    const tiedQuery = contents.join(" ");
    const tiedBefore = yield* recallIdsFor(knowledge, tiedProject, tiedQuery, "ties-before");
    assert.equal(tiedBefore.length, 2);
    const tiedOther = ProjectId.make("isolated-ties-other");
    yield* createProject(tiedOther);
    for (let i = 0; i < 100; i++)
      yield* knowledge.mutate(isolatedFact(tiedOther, `foreign-tie-${i}`, contents[0]!), {
        kind: "user",
      });
    const tiedAfter = yield* recallIdsFor(knowledge, tiedProject, tiedQuery, "ties-after");
    assert.deepEqual(tiedAfter, tiedBefore);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("superseded history changes recall of identical active facts", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const target = "The quokka telemetry exporter batches spans before flushing to the collector.";
    const query =
      "Why does the quokka telemetry exporter batch spans before flushing to the collector?";
    const fresh = ProjectId.make("op-fresh");
    yield* createProject(fresh);
    yield* knowledge.mutate(isolatedFact(fresh, "fresh-target", target), { kind: "user" });
    for (let i = 0; i < 40; i++)
      yield* knowledge.mutate(
        isolatedFact(fresh, `fresh-pad-${i}`, `Garden note ${i} about alphabets.`),
        {
          kind: "user",
        },
      );
    const freshOut = yield* recallIdsFor(knowledge, fresh, query, "fresh");
    assert.deepEqual(freshOut, [ProjectFactId.make("fresh-target")]);
    // Wipe so the two runs see the same corpus apart from history.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM project_knowledge_facts WHERE project_id = ${fresh}`;

    const hist = ProjectId.make("op-history");
    yield* createProject(hist);
    let current = yield* knowledge.mutate(isolatedFact(hist, "v0", target), { kind: "user" });
    for (let i = 1; i <= 6; i++)
      current = yield* knowledge.mutate(
        {
          action: "supersede",
          commandId: CommandId.make(`supersede:${i}`),
          projectId: hist,
          factId: current.id,
          expectedRevision: current.revision,
          replacementFactId: ProjectFactId.make(`v${i}`),
          content: `${target} (rev ${i})`,
          entities: [],
          tags: [],
          kind: "decision",
          sources: [{ kind: "user" }],
        },
        { kind: "user" },
      );
    for (let i = 0; i < 40; i++)
      yield* knowledge.mutate(
        isolatedFact(hist, `hist-pad-${i}`, `Garden note ${i} about alphabets.`),
        {
          kind: "user",
        },
      );
    const histOut = yield* recallIdsFor(knowledge, hist, query, "history");

    assert.deepEqual(histOut, ["v6"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("lost-source fact outranks a valid one", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("lost-recall");
    yield* createProject(projectId);
    const threadId = ThreadId.make("src-thread");
    const messageId = MessageId.make("src-message");
    yield* projections.apply(thread(threadId, projectId));
    yield* projections.apply(message(threadId, messageId, "assistant", "ledger decision"));
    const source = yield* knowledge.readSource({ projectId, threadId, messageId });
    if (source.state !== "available") return yield* Effect.die("source unavailable");
    const content = "The ledger labs toggle gates billing changes for invoices.";
    yield* knowledge.mutate(
      {
        ...createFact(projectId, "lost"),
        content,
        entities: ["ledger labs"],
        tags: [],
        sources: [source.source],
      },
      { kind: "user" },
    );
    yield* knowledge.mutate(
      { ...createFact(projectId, "valid"), content, entities: ["ledger labs"], tags: [] },
      { kind: "user" },
    );
    for (let i = 0; i < 40; i += 1)
      yield* knowledge.mutate(
        {
          ...createFact(projectId, `pad-${i}`),
          content: `Unrelated padding subject ${i} about alphabets and gardens.`,
          entities: [],
          tags: [],
        },
        { kind: "user" },
      );
    yield* sql`UPDATE project_knowledge_facts SET trust = 0.9 WHERE id = 'lost'`;
    yield* sql`UPDATE project_knowledge_facts SET trust = 0.6 WHERE id = 'valid'`;
    const query = "Which invoices and billing changes gate on the toggle in ledger labs?";
    const run = (id: string) =>
      knowledge.recall({
        projectId,
        threadId: ThreadId.make("t-" + id),
        requestId: CommandId.make("r-" + id),
        query,
        composer: { text: query, records: [] },
        knowledgeAllowance: 48000,
      });
    const before = yield* run("before");
    assert.deepEqual(attachedFactIds(before), [
      ProjectFactId.make("lost"),
      ProjectFactId.make("valid"),
    ]);
    const archivedThread = yield* projections.getThreadRecords(threadId, []);
    yield* projections.apply({
      id: EventId.make("arch"),
      threadId,
      type: "thread.archived",
      occurredAt: at(5),
      payload: { ...archivedThread.thread, archivedAt: at(5) },
    });
    const after = yield* run("after");
    assert.deepEqual(attachedFactIds(after), [ProjectFactId.make("valid")]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "recall uses exact terms before the candidate bound and skips background notifications",
  () =>
    Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projectId = ProjectId.make("exact-recall");
      yield* createProject(projectId);
      const query = "cobalt lantern kestrel";
      yield* knowledge.mutate(
        isolatedFact(projectId, "exact", `${query} ${"garden ".repeat(500)}`),
        { kind: "user" },
      );
      for (let i = 0; i < 130; i++)
        yield* knowledge.mutate(
          isolatedFact(projectId, `prefix-${i}`, "cobalts lanterns kestrels"),
          { kind: "user" },
        );
      const input = {
        projectId,
        threadId: ThreadId.make("exact-reader"),
        requestId: CommandId.make("exact-read"),
        query,
        composer: { text: query, records: [] },
        knowledgeAllowance: 48000,
      };
      assert.deepEqual(attachedFactIds(yield* knowledge.recall(input)), [
        ProjectFactId.make("exact"),
      ]);
      assert.deepEqual(
        attachedFactIds(
          yield* knowledge.recall({
            ...input,
            notification: {
              source: { kind: "monitor" },
              outcome: "completed",
              summary: "Checks finished",
            },
          }),
        ),
        [],
      );
      assert.deepEqual(
        attachedFactIds(
          yield* knowledge.recall({
            ...input,
            notification: {
              source: { kind: "command" },
              outcome: "completed",
              summary: "Command finished",
            },
          }),
        ),
        [],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("curation automatically erases retired memories and their retained copies", () =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("curation-lifecycle");
    const threadId = ThreadId.make("curation-source-thread");
    const messageId = MessageId.make("curation-source-message");
    yield* createProject(projectId);
    yield* projections.apply(thread(threadId, projectId));
    yield* projections.apply(
      message(
        threadId,
        messageId,
        "user",
        "For this cache task, wait for tests. Cache keys now include regions, replacing the previous policy.",
      ),
    );
    const source = yield* knowledge.readSource({ projectId, threadId, messageId });
    if (source.state !== "available") return assert.fail("Source must be available");
    const actor = {
      kind: "agent-client",
      sessionId: "curation-test",
      label: "Test agent",
    } as const;
    const old = yield* knowledge.mutate(
      { ...createFact(projectId, "curation-old"), sources: [source.source] },
      actor,
    );
    const replacement = yield* knowledge.mutate(
      {
        ...createFact(projectId, "curation-current"),
        sources: [],
        content: "Cache keys include tenant IDs and regions.",
      },
      actor,
    );
    const task = yield* knowledge.mutate(
      {
        ...createFact(projectId, "curation-task"),
        sources: [source.source],
        content: "For this cache task, wait for the current test run before merging.",
      },
      actor,
    );
    const person = yield* knowledge.mutate(createFact(projectId, "curation-person"), {
      kind: "user",
    });
    const records = [old, task, replacement].map((fact) => ({
      version: 1 as const,
      kind: "project-knowledge" as const,
      contextId: ComposerContextId.make(`curation-${fact.id}`),
      label: fact.id,
      knowledge: {
        environmentId,
        projectId,
        selections: [{ kind: "fact" as const, factId: fact.id, revision: fact.revision }],
        maxBytes: 48000,
      },
    }));
    const composer = yield* resolveKnowledgeComposer({
      projectId,
      text: records.map(formatComposerContextReference).join(" "),
      records,
    });
    yield* knowledge.recordDelivery({
      attemptId: RunAttemptId.make("curation-delivery"),
      runId: RunId.make("curation-run"),
      threadId,
      messageId,
      projectId,
      providerInstanceId,
      status: "sent",
      items: composer.items,
      omissions: composer.omissions,
      createdAt: DateTime.formatIso(at(1)),
      updatedAt: DateTime.formatIso(at(1)),
    });
    const facts = [old, replacement, task, person].map(({ id, revision }) => ({ id, revision }));
    yield* sql`UPDATE project_knowledge_fact_history SET reason = ${task.content},
      reviewed_fact_ids_json = ${JSON.stringify([task.id])} WHERE fact_id = ${person.id}`;
    const result = yield* knowledge.applyCuration({
      reviewedSources: [source.source],
      projectId,
      facts,
      decisions: [
        {
          action: "supersede",
          factId: old.id,
          expectedRevision: old.revision,
          replacementFactId: replacement.id,
          replacementRevision: replacement.revision,
          reason: `The replacement replaces this statement: ${old.content}`,
          confidence: 0.95,
        },
        {
          action: "set_aside",
          factId: task.id,
          expectedRevision: task.revision,
          verdict: "task",
          reason: `The previous fact said ${old.content}; this task said ${task.content}`,
          confidence: 0.95,
        },
      ],
    });
    assert.deepEqual(result, { changed: 2, skipped: 0 });
    const retired = yield* knowledge.readFact({ projectId, factId: old.id });
    const discarded = yield* knowledge.readFact({ projectId, factId: task.id });
    for (const detail of [retired, discarded]) {
      assert.equal(detail.fact.status, "forgotten");
      assert.isNull(detail.fact.content);
      assert.deepEqual(detail.fact.sources, []);
      assert.deepEqual(detail.fact.entities, []);
      assert.deepEqual(detail.fact.tags, []);
      assert.equal(detail.fact.revision, 2);
      assert.equal(detail.history.at(-1)?.memoryAction, "curated");
      assert.equal(detail.history.at(-1)?.actor.kind, "curator");
      assert.isTrue(
        detail.history.every(
          (entry) =>
            entry.content === null && entry.sources.length === 0 && entry.reason === undefined,
        ),
      );
      assert.equal(
        (yield* knowledge
          .mutate(
            {
              action: "restore",
              commandId: CommandId.make(`restore:${detail.fact.id}`),
              projectId,
              factId: detail.fact.id,
              expectedRevision: detail.fact.revision,
            },
            { kind: "user" },
          )
          .pipe(Effect.flip)).reason,
        "forgotten",
      );
    }
    assert.equal(retired.fact.supersededBy, replacement.id);
    assert.deepEqual(
      (yield* knowledge.readFact({ projectId, factId: replacement.id })).fact,
      replacement,
    );
    const retainedPerson = yield* knowledge.readFact({ projectId, factId: person.id });
    assert.deepEqual(retainedPerson.fact, person);
    assert.isTrue(retainedPerson.history.every((entry) => entry.reason === undefined));
    assert.deepEqual(yield* knowledge.readSource({ projectId, threadId, messageId }), source);
    assert.deepEqual((yield* knowledge.list({ projectId, verdict: "set_aside" })).facts, []);
    assert.deepEqual(
      (yield* knowledge.list({ projectId, includeSuperseded: true })).facts
        .map(({ id }) => id)
        .toSorted(),
      [replacement.id, person.id].toSorted(),
    );
    const explicit = yield* knowledge.search({
      projectId,
      query: "cache",
      requestId: CommandId.make("curation-search-explicit"),
      includeSetAside: true,
      includeSuperseded: true,
    });
    assert.isTrue(explicit.facts.state === "available");
    if (explicit.facts.state === "available") {
      assert.notInclude(
        explicit.facts.matches.map(({ fact }) => fact.id),
        task.id,
      );
      assert.notInclude(
        explicit.facts.matches.map(({ fact }) => fact.id),
        old.id,
      );
    }
    const { deliveries } = yield* knowledge.readDeliveries({ projectId, threadId, messageId });
    assert.deepEqual(
      deliveries[0]?.items.map((item) => [item.text, item.contentRemoved ?? false]),
      [
        ["", true],
        ["", true],
        [composer.items[2]!.text, false],
      ],
    );
    yield* decodeLegacyHistoryEvents(
      [...retired.history, ...discarded.history].map(({ event }) => event),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "curation rejects foreign evidence and stale or protected snapshots without partial changes",
  () =>
    Effect.gen(function* () {
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const projectId = ProjectId.make("curation-races");
      const otherProject = ProjectId.make("curation-foreign");
      yield* createProject(projectId);
      yield* createProject(otherProject);
      const actor = {
        kind: "agent-client",
        sessionId: "curation-test",
        label: "Test agent",
      } as const;
      const first = yield* knowledge.mutate(
        { ...createFact(projectId, "curation-first"), sources: [] },
        actor,
      );
      const second = yield* knowledge.mutate(
        { ...createFact(projectId, "curation-second"), sources: [] },
        actor,
      );
      const foreign = yield* knowledge.mutate(
        { ...createFact(otherProject, "curation-foreign-fact"), sources: [] },
        actor,
      );
      const decision = {
        action: "set_aside",
        factId: first.id,
        expectedRevision: first.revision,
        verdict: "task",
        reason: "This is a task note.",
        confidence: 0.95,
      } as const;
      const snapshots = [first, second].map(({ id, revision }) => ({ id, revision }));
      const foreignAttempt = yield* knowledge.applyCuration({
        reviewedSources: [],
        projectId,
        facts: [...snapshots, { id: foreign.id, revision: foreign.revision }],
        decisions: [decision],
      });
      assert.deepEqual(foreignAttempt, { changed: 0, skipped: 1 });
      assert.equal(
        (yield* knowledge
          .applyCuration({
            reviewedSources: [],
            projectId,
            facts: snapshots,
            decisions: [
              decision,
              {
                action: "supersede",
                factId: second.id,
                expectedRevision: second.revision,
                replacementFactId: foreign.id,
                replacementRevision: foreign.revision,
                reason: "Foreign project replacement.",
                confidence: 0.95,
              },
            ],
          })
          .pipe(Effect.flip)).reason,
        "invalid_curation",
      );
      assert.equal(
        (yield* knowledge.readFact({ projectId, factId: first.id })).fact.revision,
        first.revision,
      );
      assert.equal(
        (yield* knowledge
          .applyCuration({
            reviewedSources: [],
            projectId,
            facts: snapshots.map((fact) => ({ ...fact, protected: true })),
            decisions: [decision],
          })
          .pipe(Effect.flip)).reason,
        "invalid_curation",
      );
      yield* knowledge.mutate(
        {
          ...createFact(projectId, second.id),
          action: "edit",
          commandId: CommandId.make("edit-during-curation"),
          expectedRevision: second.revision,
          content: "The user changed the context while review was running.",
        },
        { kind: "user" },
      );
      assert.deepEqual(
        yield* knowledge.applyCuration({
          reviewedSources: [],
          projectId,
          facts: snapshots,
          decisions: [decision],
        }),
        { changed: 0, skipped: 1 },
      );
      assert.equal(
        (yield* knowledge.readFact({ projectId, factId: first.id })).fact.revision,
        first.revision,
      );
    }).pipe(Effect.provide(layerTest)),
);
