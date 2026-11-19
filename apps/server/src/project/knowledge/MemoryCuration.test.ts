import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectFactId,
  ProjectId,
  ProviderInstanceId,
  TextGenerationError,
  ThreadId,
  type KnowledgeFactSource,
  type OrchestrationV2MessageProvenance,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import Migration0068 from "../../persistence/Migrations/068_ProjectKnowledge.ts";
import Migration0070 from "../../persistence/Migrations/070_ProjectKnowledgeHistory.ts";
import Migration0121 from "../../persistence/Migrations/121_ProjectMemoryCuration.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as HolographicMemory from "./HolographicMemory.ts";
import * as MemoryCuration from "./MemoryCuration.ts";
import * as ProjectKnowledge from "./ProjectKnowledge.ts";

type Generate = TextGeneration.TextGeneration["Service"]["curateProjectMemory"];
const makeLayer = (generate: Generate, canCurate = true) =>
  MemoryCuration.layerRunner.pipe(
    Layer.provideMerge(
      Layer.mock(TextGeneration.TextGeneration)({
        curateProjectMemory: generate,
        supportsOperation: () => Effect.succeed(canCurate),
      }),
    ),
    Layer.provideMerge(ProjectKnowledge.layer.pipe(Layer.provide(HolographicMemory.layer))),
    Layer.provideMerge(
      Layer.mergeAll(ProjectStore.layer, ProjectionStore.layer, ThreadSearch.layer),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("curation-test")),
      }),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const createProject = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* projects.apply({
      sequence: 0,
      eventId: EventId.make(`created:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: at,
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
        createdAt: at,
        updatedAt: at,
      },
    });
  });

const createFact = (
  projectId: ProjectId,
  id: string,
  content: string,
  user = false,
  sources: ReadonlyArray<KnowledgeFactSource> = [],
) =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    return yield* knowledge.mutate(
      {
        action: "create",
        commandId: CommandId.make(`create:${id}`),
        projectId,
        factId: ProjectFactId.make(id),
        content,
        kind: "decision",
        entities: [],
        tags: [],
        sources: user ? [{ kind: "user" }] : sources,
      },
      user
        ? { kind: "user" }
        : { kind: "agent-client", sessionId: "test-curator", label: "Test agent" },
    );
  });

const readState = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* sql<{
      cursor: string | null;
      nextDue: number;
      status: string;
      reason: string | null;
      reviewed: number;
      changed: number;
      skipped: number;
    }>`SELECT cursor, next_due_at AS "nextDue", status, reason, reviewed, changed, skipped
    FROM project_knowledge_curation_state WHERE project_id = ${projectId}`)[0]!;
  });

it.effect("curates only the selected project's automatic facts and protects user choices", () => {
  const calls: Array<Parameters<Generate>[0]> = [];
  const generate: Generate = (input) => {
    calls.push(input);
    return Effect.succeed({
      decisions: input.facts
        .filter((fact) => !fact.protected)
        .map((fact) => ({
          action: "set_aside" as const,
          factId: fact.id,
          expectedRevision: fact.revision,
          verdict: "task" as const,
          confidence: 0.95,
          reason: "This instruction only describes the current task.",
        })),
    });
  };
  return Effect.gen(function* () {
    const alpha = ProjectId.make("alpha");
    const beta = ProjectId.make("beta");
    yield* createProject(alpha);
    yield* createProject(beta);
    yield* createFact(alpha, "alpha-auto", "Deployment is limited to the current task.");
    yield* createFact(alpha, "alpha-user", "Deployment approvals always require the owner.", true);
    yield* createFact(
      alpha,
      "alpha-person",
      "Deployment convention explicitly retained by the owner.",
    );
    yield* createFact(
      beta,
      "beta-auto",
      "Deployment temporary override for the unrelated beta project.",
    );
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE project_knowledge_facts SET verdict = 'standing', verdict_by = 'person',
      verdict_at = '1970-01-01T00:00:00.000Z' WHERE id = 'alpha-person'`;
    const curator = yield* MemoryCuration.MemoryCuration;
    yield* curator.drainDue;
    assert.equal(calls.length, 2);
    const fileSystem = yield* FileSystem.FileSystem;
    for (const call of calls) {
      const owner = call.facts.find((fact) => !fact.protected)!.id.split("-")[0]!;
      assert.ok(call.facts.every((fact) => fact.id.startsWith(owner)));
      assert.notEqual(call.cwd, `/work/${owner}`);
      assert.isFalse(yield* fileSystem.exists(call.cwd));
      assert.deepEqual(
        call.facts.filter((fact) => !fact.protected).map((fact) => fact.id),
        [`${owner}-auto`],
      );
    }
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    assert.equal(
      (yield* knowledge.readFact({ projectId: alpha, factId: ProjectFactId.make("alpha-auto") }))
        .fact.verdict?.value,
      "task",
    );
    assert.equal(
      (yield* knowledge.readFact({ projectId: alpha, factId: ProjectFactId.make("alpha-user") }))
        .fact.revision,
      1,
    );
    assert.equal(
      (yield* knowledge.readFact({ projectId: alpha, factId: ProjectFactId.make("alpha-person") }))
        .fact.verdict?.by,
      "person",
    );
    assert.equal((yield* readState(alpha)).changed, 1);
  }).pipe(Effect.provide(makeLayer(generate)));
});

it.effect(
  "bounds each tick, resumes fair pages after restart, and pauses after a complete sweep",
  () => {
    const calls: Array<Parameters<Generate>[0]> = [];
    return Effect.gen(function* () {
      const bulk = ProjectId.make("a-bulk");
      yield* createProject(bulk);
      for (let index = 0; index < 35; index++)
        yield* createFact(
          bulk,
          `bulk-${String(index).padStart(2, "0")}`,
          `Stable deployment decision ${index}.`,
        );
      for (const id of ["b", "c", "d", "e", "f"]) {
        const projectId = ProjectId.make(id);
        yield* createProject(projectId);
        yield* createFact(projectId, `${id}-fact`, `Stable rule for ${id}.`);
      }
      const curator = yield* MemoryCuration.MemoryCuration;
      yield* curator.drainDue;
      assert.equal(calls.length, 4);
      assert.equal((yield* readState(bulk)).cursor, "bulk-15");
      yield* curator.drainDue;
      assert.equal(calls.length, 6);
      yield* Effect.flatMap(MemoryCuration.MemoryCuration, (fresh) => fresh.drainDue).pipe(
        Effect.provide(MemoryCuration.layerRunner),
      );
      assert.equal(calls.length, 6);
      yield* TestClock.adjust("15 minutes");
      yield* curator.drainDue;
      assert.equal((yield* readState(bulk)).cursor, "bulk-31");
      yield* TestClock.adjust("15 minutes");
      yield* curator.drainDue;
      const reviewed = calls
        .filter((call) => call.facts.some((fact) => !fact.protected && fact.id.startsWith("bulk-")))
        .flatMap((call) => {
          assert.ok(call.facts.length <= 24);
          return call.facts.filter((fact) => !fact.protected).map((fact) => fact.id);
        });
      assert.equal(reviewed.length, 35);
      assert.equal(new Set(reviewed).size, 35);
      assert.equal((yield* readState(bulk)).cursor, null);
      yield* TestClock.adjust("15 minutes");
      yield* curator.drainDue;
      assert.equal(calls.length, 8);
    }).pipe(
      Effect.provide(
        makeLayer((input) => {
          calls.push(input);
          return Effect.succeed({ decisions: [] });
        }),
      ),
    );
  },
);

it.effect("honors a project disable while the model is reviewing without applying its result", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const generate: Generate = (input) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(release);
        return {
          decisions: [
            {
              action: "set_aside" as const,
              factId: input.facts[0]!.id,
              expectedRevision: input.facts[0]!.revision,
              verdict: "task" as const,
              confidence: 0.95,
              reason: "Task-specific instruction.",
            },
          ],
        };
      });
    yield* Effect.gen(function* () {
      const projectId = ProjectId.make("disabled");
      yield* createProject(projectId);
      yield* createFact(projectId, "disabled-fact", "Only change this file for this task.");
      const curator = yield* MemoryCuration.MemoryCuration;
      const running = yield* Effect.forkChild(curator.drainDue);
      yield* Deferred.await(started);
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        projectSettingsOverrides: { [projectId]: { enableMemoryCuration: false } },
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(running);
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const { fact } = yield* knowledge.readFact({
        projectId,
        factId: ProjectFactId.make("disabled-fact"),
      });
      assert.equal(fact.revision, 1);
      assert.equal((yield* readState(projectId)).reason, "disabled");
      assert.equal((yield* readState(projectId)).changed, 0);
    }).pipe(Effect.provide(makeLayer(generate)));
  }),
);

it.effect(
  "records invalid and failed reviews, preserves facts, and persists retry cooldown",
  () => {
    let calls = 0;
    const generate: Generate = () => {
      calls++;
      if (calls === 1)
        return Effect.succeed({
          decisions: [
            {
              action: "set_aside",
              factId: "foreign-fact",
              expectedRevision: 1,
              verdict: "task",
              confidence: 0.95,
              reason: "A foreign target must be rejected.",
            },
          ],
        });
      if (calls === 2)
        return Effect.fail(
          new TextGenerationError({
            operation: "curateProjectMemory",
            detail: "Backend unavailable.",
          }),
        );
      return Effect.succeed({ decisions: [] });
    };
    return Effect.gen(function* () {
      const projectId = ProjectId.make("failure");
      yield* createProject(projectId);
      yield* createFact(
        projectId,
        "failure-fact",
        "Stable deployment rule with sensitive content.",
      );
      const curator = yield* MemoryCuration.MemoryCuration;
      yield* curator.drainDue;
      assert.equal((yield* readState(projectId)).reason, "invalid_output");
      yield* Effect.flatMap(MemoryCuration.MemoryCuration, (fresh) => fresh.drainDue).pipe(
        Effect.provide(MemoryCuration.layerRunner),
      );
      assert.equal(calls, 1);
      yield* TestClock.adjust("15 minutes");
      yield* curator.drainDue;
      assert.equal((yield* readState(projectId)).status, "failed");
      assert.equal((yield* readState(projectId)).reason, "review_failed");
      yield* TestClock.adjust("15 minutes");
      yield* curator.drainDue;
      const state = yield* readState(projectId);
      assert.equal(state.status, "ran");
      assert.equal(state.reason, "unchanged");
      assert.equal(state.changed, 0);
      assert.ok(!JSON.stringify(state).includes("sensitive content"));
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      assert.equal(
        (yield* knowledge.readFact({ projectId, factId: ProjectFactId.make("failure-fact") })).fact
          .revision,
        1,
      );
    }).pipe(Effect.provide(makeLayer(generate)));
  },
);

it.effect("keeps a user edit made while curation was reviewing an older revision", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const projectId = ProjectId.make("concurrent");
      const factId = ProjectFactId.make("concurrent-fact");
      yield* createProject(projectId);
      yield* createFact(projectId, factId, "Only touch the deployment script for this task.");
      const curator = yield* MemoryCuration.MemoryCuration;
      const running = yield* Effect.forkChild(curator.drainDue);
      yield* Deferred.await(started);
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      yield* knowledge.mutate(
        {
          action: "edit",
          commandId: CommandId.make("user-edit"),
          projectId,
          factId,
          expectedRevision: 1,
          content: "Always require review for deployment changes.",
          kind: "constraint",
          entities: [],
          tags: [],
          sources: [{ kind: "user" }],
        },
        { kind: "user" },
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(running);
      const { fact } = yield* knowledge.readFact({ projectId, factId });
      assert.equal(fact.content, "Always require review for deployment changes.");
      assert.equal(fact.revision, 2);
      assert.equal((yield* readState(projectId)).changed, 0);
      assert.equal((yield* readState(projectId)).skipped, 1);
    }).pipe(
      Effect.provide(
        makeLayer((input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return {
              decisions: [
                {
                  action: "set_aside" as const,
                  factId: input.facts[0]!.id,
                  expectedRevision: input.facts[0]!.revision,
                  verdict: "task" as const,
                  confidence: 0.95,
                  reason: "Task-specific instruction.",
                },
              ],
            };
          }),
        ),
      ),
    );
  }),
);

const createMessage = (
  projectId: ProjectId,
  text: string,
  provenance?: OrchestrationV2MessageProvenance,
) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const at = yield* DateTime.now;
    const threadId = ThreadId.make(`${projectId}-thread`);
    const messageId = MessageId.make(`${projectId}-message`);
    const providerInstanceId = ProviderInstanceId.make("codex");
    yield* projections.apply({
      id: EventId.make(`thread:${threadId}`),
      type: "thread.created",
      threadId,
      providerInstanceId,
      occurredAt: at,
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
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    yield* projections.apply({
      id: EventId.make(`message:${messageId}`),
      type: "message.updated",
      threadId,
      providerInstanceId,
      occurredAt: at,
      payload: {
        createdBy: "user",
        creationSource: "web",
        ...provenance,
        id: messageId,
        threadId,
        runId: null,
        nodeId: null,
        role: "user",
        text,
        attachments: [],
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
    });
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const source = yield* knowledge.readSource({ projectId, threadId, messageId });
    if (source.state !== "available") return yield* Effect.die("Source must be available");
    return source.source;
  });

it.effect.each(["human", "local-agent", "linked-agent"] as const)(
  "preserves verified source attribution and bounds while excluding a corrupt cross-project citation: %s",
  (kind) => {
    const calls: Array<Parameters<Generate>[0]> = [];
    return Effect.gen(function* () {
      const projectId = ProjectId.make("sources");
      const other = ProjectId.make("other");
      yield* createProject(projectId);
      yield* createProject(other);
      const claim = "Public APIs must keep stable response formats.";
      const provenance: OrchestrationV2MessageProvenance | undefined =
        kind === "human"
          ? undefined
          : kind === "local-agent"
            ? {
                createdBy: "user",
                creationSource: "mcp",
                senderThreadId: ThreadId.make("coordinator-thread"),
              }
            : {
                createdBy: "agent",
                creationSource: "mcp",
                linkedSender: {
                  environmentId: EnvironmentId.make("coordinator-environment"),
                  threadId: ThreadId.make("coordinator-thread"),
                  title: "Lab coordinator",
                },
              };
      const own = yield* createMessage(
        projectId,
        kind === "human" ? claim : `${claim} ${"Additional context. ".repeat(200)}`,
        provenance,
      );
      const foreign = yield* createMessage(
        other,
        "Unrelated project's secret deployment configuration.",
      );
      yield* createFact(projectId, "source-fact", "Stable API response format.", false, [own]);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE project_knowledge_facts SET sources_json = ${JSON.stringify([own, foreign])} WHERE id = 'source-fact'`;
      const curator = yield* MemoryCuration.MemoryCuration;
      yield* curator.drainDue;
      assert.equal(calls.length, 1);
      const sources = calls[0]!.facts[0]!.sources;
      assert.lengthOf(sources, 1);
      if (kind === "human") {
        assert.deepEqual(sources, [`user: ${claim}`]);
      } else {
        const excerpt = sources[0]!;
        assert.include(excerpt, "coordinator-thread");
        assert.include(excerpt, "not a direct message from the human user");
        assert.include(excerpt, claim);
        assert.notMatch(excerpt, /^user:/);
        assert.equal(excerpt.length, 3_000);
        if (kind === "linked-agent") {
          assert.include(excerpt, "coordinator-environment");
          assert.include(excerpt, "Lab coordinator");
        }
      }
    }).pipe(
      Effect.provide(
        makeLayer((input) => {
          calls.push(input);
          return Effect.succeed({ decisions: [] });
        }),
      ),
    );
  },
);

it.effect.each(["edited", "deleted", "unchanged"] as const)(
  "rechecks %s context source evidence before committing a replacement",
  (change) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let packet: Parameters<Generate>[0] | undefined;
      const generate: Generate = (input) =>
        Effect.gen(function* () {
          packet = input;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return {
            decisions: [
              {
                action: "supersede" as const,
                factId: "a-old",
                expectedRevision: 1,
                replacementFactId: "b-current",
                replacementRevision: 1,
                confidence: 0.95,
                reason: "The reviewed source explicitly replaces the earlier cache policy.",
              },
            ],
          };
        });
      yield* Effect.gen(function* () {
        const projectId = ProjectId.make("evidence-race");
        yield* createProject(projectId);
        const source = yield* createMessage(
          projectId,
          "Cache keys now include regions; this replaces the previous policy.",
        );
        yield* createFact(projectId, "a-old", "Cache keys omit regions.");
        yield* createFact(projectId, "b-current", "Cache keys include regions.");
        yield* createFact(
          projectId,
          "c-context",
          "Cache key policy changed after the deployment review.",
          false,
          [source],
        );
        yield* createFact(
          projectId,
          "d-missing-context",
          "Cache policy has an older unavailable discussion.",
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE project_knowledge_facts SET verdict = 'standing', verdict_by = 'person',
        verdict_at = '1970-01-01T00:00:00.000Z' WHERE id IN ('c-context', 'd-missing-context')`;
        const missing = { ...source, messageId: MessageId.make("missing-before-review") };
        yield* sql`UPDATE project_knowledge_facts SET sources_json = ${JSON.stringify([missing])}
        WHERE id = 'd-missing-context'`;
        const curator = yield* MemoryCuration.MemoryCuration;
        const reviewing = yield* Effect.forkChild(curator.drainDue);
        yield* Deferred.await(started);
        assert.deepEqual(packet?.facts.find((fact) => fact.id === "c-context")?.sources, [
          "user: Cache keys now include regions; this replaces the previous policy.",
        ]);
        assert.deepEqual(
          packet?.facts.find((fact) => fact.id === "d-missing-context")?.sources,
          [],
        );
        if (change === "edited") {
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const at = yield* DateTime.now;
          yield* projections.apply({
            id: EventId.make("evidence-corrected"),
            type: "message.updated",
            threadId: source.threadId,
            providerInstanceId: ProviderInstanceId.make("codex"),
            occurredAt: at,
            payload: {
              createdBy: "user",
              creationSource: "web",
              id: source.messageId,
              threadId: source.threadId,
              runId: null,
              nodeId: null,
              role: "user",
              text: "Correction: the previous cache key policy still applies.",
              attachments: [],
              streaming: false,
              createdAt: at,
              updatedAt: at,
            },
          });
        } else if (change === "deleted") {
          yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '1970-01-01T00:00:00.000Z'
          WHERE thread_id = ${source.threadId}`;
        }
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(reviewing);
        const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
        const old = (yield* knowledge.readFact({ projectId, factId: ProjectFactId.make("a-old") }))
          .fact;
        assert.equal(old.supersededBy, change === "unchanged" ? "b-current" : null);
        assert.equal(
          (yield* knowledge.readFact({ projectId, factId: ProjectFactId.make("c-context") })).fact
            .revision,
          1,
        );
        const state = yield* readState(projectId);
        assert.equal(state.status, "ran");
        assert.equal(state.changed, change === "unchanged" ? 1 : 0);
        assert.equal(state.skipped, change === "unchanged" ? 0 : 1);
      }).pipe(Effect.provide(makeLayer(generate)));
    }),
);

it.effect(
  "migrates prior fact history without changing identities and accepts curation outcomes",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration0068;
      yield* Migration0070;
      yield* sql`INSERT INTO project_knowledge_fact_history (
    sequence, project_id, fact_id, revision, event, actor_json, content_digest, content,
    sources_json, trust_before, trust_after, helpful, related_fact_id, created_at
  ) VALUES (42, 'project', 'fact', 2, 'edited', '{"kind":"user"}', 'digest', 'Keep this decision',
    '[{"kind":"user"}]', 0.5, 0.8, NULL, NULL, '2026-01-01T00:00:00.000Z')`;
      const before = yield* sql`SELECT * FROM project_knowledge_fact_history`;
      yield* Migration0121;
      const after = yield* sql`SELECT * FROM project_knowledge_fact_history`;
      assert.deepEqual(
        after,
        before.map((row) => ({ ...row, reason: null, reviewed_fact_ids_json: "[]" })),
      );
      yield* sql`INSERT INTO project_knowledge_fact_history (
    project_id, fact_id, revision, event, actor_json, content, sources_json, trust_after, created_at, reason
  ) VALUES ('project', 'fact', 3, 'curated', '{"kind":"curator"}', 'Keep this decision', '[]', 0.8,
    '2026-01-02T00:00:00.000Z', 'Duplicate of another saved fact')`;
      assert.equal(
        (yield* sql<{
          sequence: number;
        }>`SELECT MAX(sequence) AS sequence FROM project_knowledge_fact_history`)[0]!.sequence,
        43,
      );
      assert.deepEqual(
        yield* sql`SELECT name FROM sqlite_schema WHERE name = 'project_knowledge_fact_history_curated'`,
        [],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
