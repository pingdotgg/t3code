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
  ThreadId,
  TurnItemId,
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

const environmentId = EnvironmentId.make("knowledge-test-environment");
const knowledgeTestLayer = (scoring: typeof HolographicMemory.layer = HolographicMemory.layer) =>
  ProjectKnowledge.layer.pipe(
    Layer.provide(scoring),
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
  ProjectionStore.layer,
);
const receiptExecutor = Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
  execute: () => Effect.die("Unexpected effect"),
});
const receiptTestLayer = Layer.mergeAll(
  EventSink.layerFromStores,
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
      assert.include(header!, "revision:1 status:confirmed trust:0.5; User assertion]");
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
    assert.equal(saved.status, "confirmed");
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

it.effect(
  "recalls agent proposals before optional human confirmation and rehydrates exact sources",
  () =>
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
      const proposed = yield* knowledge.mutate(
        { ...createFact(projectId), sources: [source.source] },
        { kind: "agent-client", sessionId: "test-agent", label: "Test agent" },
      );
      assert.equal(proposed.status, "proposed");
      assert.deepEqual((yield* knowledge.list({ projectId })).facts, []);
      const context = {
        environmentId,
        projectId,
        selections: [{ kind: "fact" as const, factId: proposed.id, revision: 1 }],
        maxBytes: 4096,
      };
      const unconfirmed = yield* knowledge.prepareContext(context);
      assert.include(unconfirmed.text, "status:proposed");
      const confirm = {
        action: "confirm" as const,
        commandId: CommandId.make("confirm"),
        projectId,
        factId: proposed.id,
        expectedRevision: 1,
      };
      const forbidden = yield* knowledge
        .mutate(confirm, { kind: "agent-client", sessionId: "test-agent", label: "Test agent" })
        .pipe(Effect.result);
      assert.equal(
        Result.isFailure(forbidden) && forbidden.failure.reason,
        "user_confirmation_required",
      );
      const confirmed = yield* knowledge.mutate(confirm, { kind: "user" });
      const preview = yield* knowledge.prepareContext({
        ...context,
        selections: [{ kind: "fact", factId: confirmed.id, revision: confirmed.revision }],
      });
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

it.effect("MCP rejects unauthorized mutations and cannot confirm its own proposals", () =>
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
    const proposal = { ...createFact(projectId), sources: [source.source] };
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
    assert.deepInclude(yield* invoke(proposal, "read-only"), { code: "capability_denied" });
    assert.deepInclude(yield* invoke(proposal, "full-access", false), {
      code: "capability_denied",
    });
    assert.deepEqual((yield* knowledge.list({ projectId, status: "proposed" })).facts, []);
    assert.deepInclude(yield* invoke(proposal, "full-access"), { status: "proposed", revision: 1 });
    assert.deepInclude(
      yield* invoke(
        {
          action: "confirm",
          commandId: CommandId.make("mcp-confirm"),
          projectId,
          factId: proposal.factId,
          expectedRevision: 1,
        },
        "full-access",
      ),
      {
        code: "invalid_request",
        message: "A user must confirm proposed knowledge.",
      },
    );
    const observation = { ...createFact(projectId, "agent-observation"), sources: [] };
    const created = yield* invoke(observation, "full-access");
    assert.deepInclude(created, {
      status: "proposed",
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
          (match) => match.fact.id === observation.factId && match.fact.status === "proposed",
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
        status: "proposed",
        origin: { kind: "agent-client", sessionId: "test-client", label: "Test client" },
      },
    );
    assert.deepEqual((yield* knowledge.list({ projectId })).facts, []);
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
      assert.deepEqual([...evidence.keys()], ["item:sent"]);
      assert.include(evidence.get("item:sent"), "Cache keys include tenant IDs.");
      assert.notInclude(evidence.get("item:sent"), "region IDs");

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
      assert.deepEqual([...(yield* handoff).keys()], []);
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
    assert.equal(evidence.size, 2);
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
      (yield* historyEvidence).get("original-delivered-item")!,
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
    assert.equal((yield* historyEvidence).size, 0);
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

it.effect.each(["confirm", "feedback"] as const)(
  "scrubs a delivered %s revision using the citations that supplied its content",
  (action) =>
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
          commandId: CommandId.make(`delivered-${action}`),
          projectId,
          factId: created.id,
          expectedRevision: created.revision,
          ...(action === "feedback" ? { action, helpful: true } : { action }),
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
        assert.notInclude(replay.get("removed-source-replay"), "Cache keys include tenant IDs.");
        assert.include(replay.get("removed-source-replay"), "Source unavailable");
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
    assert.equal(yield* searchCount("browse", false), 0);
    assert.equal(yield* storedCount, 0);
    assert.equal(yield* searchCount("agent"), 1);
    assert.equal(yield* storedCount, 1);
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
    const proposed = yield* knowledge.mutate({ ...createFact(projectId), sources: [] }, agent);
    const edited = yield* knowledge.mutate(
      {
        ...existing(proposed, "history-edit"),
        action: "edit",
        content: "Cache keys include tenant and region IDs.",
        entities: ["cache"],
        tags: [],
        kind: "decision",
        sources: [],
      },
      agent,
    );
    const confirmed = yield* knowledge.mutate(
      { ...existing(edited, "history-confirm"), action: "confirm" },
      { kind: "user" },
    );
    const helpful = yield* knowledge.mutate(
      { ...existing(confirmed, "history-up"), action: "feedback", helpful: true },
      { kind: "user" },
    );
    const unhelpful = yield* knowledge.mutate(
      { ...existing(helpful, "history-down"), action: "feedback", helpful: false },
      { kind: "user" },
    );
    const detail = yield* knowledge.readFact({ projectId, factId: proposed.id });
    assert.deepEqual(
      detail.history.map((entry) => [entry.event, entry.revision, entry.helpful]),
      [
        ["created", 1, null],
        ["edited", 2, null],
        ["confirmed", 3, null],
        ["feedback", 4, true],
        ["feedback", 5, false],
      ],
    );
    assert.deepEqual(detail.history[0]?.actor, agent);
    assert.equal(detail.history[1]?.content, "Cache keys include tenant and region IDs.");
    assert.match(detail.history[1]?.contentDigest ?? "", /^[a-f0-9]{64}$/);
    assert.notEqual(detail.history[0]?.contentDigest, detail.history[1]?.contentDigest);
    assert.deepEqual(
      detail.history.slice(3).map((entry) => [entry.trustBefore, entry.trustAfter]),
      [
        [0.5, 0.55],
        [0.55, unhelpful.trust],
      ],
    );
    assert.isFalse(detail.historyTruncated);

    yield* knowledge.mutate(
      { ...existing(unhelpful, "history-forget"), action: "forget" },
      { kind: "user" },
    );
    const forgotten = yield* knowledge.readFact({ projectId, factId: proposed.id });
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
    assert.equal(before.fact.status, "confirmed");
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
    const proposed = yield* knowledge.mutate(
      { ...createFact(projectId, "proposed"), sources: [] },
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
      { ...existing(proposed, "praise"), action: "feedback", helpful: true },
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

    const status = yield* knowledge.status({ projectId });
    assert.deepEqual(status.counts, { proposed: 1, confirmed: 3, superseded: 1, forgotten: 1 });
    // cited 0.5, proposed 0.55, new 0.5, distrusted 0.2.
    assert.deepEqual(status.trustBands, { low: 1, guarded: 0, steady: 3, high: 0 });
    assert.equal(status.belowRecallThreshold, 1);
    assert.deepEqual(status.feedback, { helpful: 1, unhelpful: 3 });
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
