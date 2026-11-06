import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectFactId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  TextGenerationError,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as AssistedLearning from "./AssistedLearning.ts";
import { AssistedLearningRunner, assistedLearningEffects } from "./assistedLearningSchedule.ts";
import * as HolographicMemory from "./HolographicMemory.ts";
import * as ProjectKnowledge from "./ProjectKnowledge.ts";

const isTextGenerationError = Schema.is(TextGenerationError);

type Generate = TextGeneration.TextGeneration["Service"]["generateKnowledgeCandidates"];

const projectId = ProjectId.make("learning");
const threadId = ThreadId.make("learning-thread");
const runId = RunId.make("learning-run");
const providerInstanceId = ProviderInstanceId.make("codex");
const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 1));

const makeLayer = (
  generate: Generate,
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
) =>
  AssistedLearning.layerRunner.pipe(
    Layer.provide(
      Layer.mock(TextGeneration.TextGeneration)({ generateKnowledgeCandidates: generate }),
    ),
    Layer.provideMerge(ProjectKnowledge.layer.pipe(Layer.provide(HolographicMemory.layer))),
    Layer.provideMerge(
      Layer.mergeAll(ProjectStore.layer, ProjectionStore.layer, ThreadSearch.layer),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerSettings.layerTest(settings)),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("learning-environment")),
      }),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

/** A text generation double that records each call and replies from a script. */
const scripted = (
  replies: ReadonlyArray<TextGeneration.KnowledgeCandidatesGenerationResult | TextGenerationError>,
) => {
  const calls: Array<Parameters<Generate>[0]> = [];
  const generate: Generate = (input) => {
    const reply = replies[Math.min(calls.length, replies.length - 1)]!;
    calls.push(input);
    return isTextGenerationError(reply) ? Effect.fail(reply) : Effect.succeed(reply);
  };
  return { calls, generate };
};

const seedRun = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  yield* projects.apply({
    sequence: 0,
    eventId: EventId.make(`created:${projectId}`),
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
      title: projectId,
      workspaceRoot: `/work/${projectId}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: DateTime.formatIso(at),
      updatedAt: DateTime.formatIso(at),
    },
  });
  const thread: OrchestrationV2DomainEvent = {
    id: EventId.make(`created:${threadId}`),
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
  };
  yield* projections.apply(thread);
  const messages = [
    ["learning-user", "user", "From now on API responses use snake_case keys everywhere."],
    ["learning-reply", "assistant", "Done. I converted the handlers to snake_case keys."],
  ] as const;
  for (const [index, [id, role, text]] of messages.entries()) {
    const createdAt = DateTime.add(at, { minutes: index + 1 });
    yield* projections.apply({
      id: EventId.make(`message:${id}`),
      type: "message.updated",
      threadId,
      providerInstanceId,
      occurredAt: createdAt,
      payload: {
        createdBy: role === "user" ? "user" : "agent",
        creationSource: role === "user" ? "web" : "provider",
        id: MessageId.make(id),
        threadId,
        runId,
        nodeId: null,
        role,
        text,
        attachments: [],
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      },
    });
  }
});

/** More finished replies in the same run, after the two seedRun writes. */
const seedReplies = (count: number) =>
  Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
    Effect.forEach(
      Array.from({ length: count }, (_, index) => index),
      (index) => {
        const createdAt = DateTime.add(at, { minutes: 3 + index });
        return projections.apply({
          id: EventId.make(`message:learning-extra-${index}`),
          type: "message.updated",
          threadId,
          providerInstanceId,
          occurredAt: createdAt,
          payload: {
            createdBy: "agent",
            creationSource: "provider",
            id: MessageId.make(`learning-extra-${index}`),
            threadId,
            runId,
            nodeId: null,
            role: "assistant",
            text: `Converted handler ${index} to snake_case keys.`,
            attachments: [],
            streaming: false,
            createdAt,
            updatedAt: createdAt,
          },
        });
      },
    ),
  );

const sha256 = (text: string) =>
  Effect.flatMap(Digest.Digest, (crypto) =>
    crypto.digest(Digest.sha256, new TextEncoder().encode(text)),
  ).pipe(Effect.map(Hex.encode));

const snakeCase = {
  kind: "convention" as const,
  content: "API responses use snake_case keys.",
  entities: ["api"],
  citations: ["M1", "M2"],
};

it("schedules one coalesced job per run unless the environment or project opted out", () => {
  const input = { projectId, threadId, runId, status: "completed" as const };
  const settings = DEFAULT_SERVER_SETTINGS;
  assert.deepEqual(
    assistedLearningEffects({
      ...input,
      settings: { ...DEFAULT_SERVER_SETTINGS, enableAssistedLearning: false },
    }),
    [],
  );
  assert.deepEqual(
    assistedLearningEffects({
      ...input,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: { [projectId]: { enableAssistedLearning: false } },
      },
    }),
    [],
  );
  const [effect] = assistedLearningEffects({ ...input, settings });
  assert.equal(effect?.id, `effect:project-knowledge.extract:${runId}`);
  assert.deepEqual(effect?.request, {
    type: "project-knowledge.extract",
    runId,
    runOutcome: "completed",
  });
  assert.deepEqual(
    assistedLearningEffects({ ...input, status: "cancelled", settings })[0]?.request,
    { type: "project-knowledge.extract", runId, runOutcome: "interrupted" },
  );
});

it.effect("saves a settled run's cited facts exactly once, recallable without review", () => {
  const model = scripted([
    { candidates: [snakeCase, { ...snakeCase, content: "Invented.", citations: ["M9"] }] },
  ]);
  return Effect.gen(function* () {
    yield* seedRun;
    const runner = yield* AssistedLearningRunner;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
    // A replayed or retried effect for the same run does not call the model again.
    yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
    assert.equal(model.calls.length, 1);
    assert.deepEqual(
      model.calls[0]!.messages.map((message) => [message.ref, message.role]),
      [
        ["M1", "user"],
        ["M2", "assistant"],
      ],
    );
    const { facts } = yield* knowledge.list({ projectId, status: "saved", origin: "assisted" });
    assert.equal(facts.length, 1);
    const fact = facts[0]!;
    assert.equal(fact.status, "saved");
    assert.equal(fact.content, snakeCase.content);
    assert.deepEqual(fact.origin, { kind: "assisted", threadId, runId, runOutcome: "completed" });
    assert.deepEqual(fact.sources, [
      {
        kind: "message",
        threadId,
        messageId: MessageId.make("learning-user"),
        digest: yield* sha256("From now on API responses use snake_case keys everywhere."),
      },
      {
        kind: "message",
        threadId,
        messageId: MessageId.make("learning-reply"),
        digest: yield* sha256("Done. I converted the handlers to snake_case keys."),
      },
    ]);
    const status = yield* knowledge.status({ projectId });
    assert.deepEqual(
      status.assistedLearning?.lastRun && {
        result: status.assistedLearning.lastRun.result,
        saved: status.assistedLearning.lastRun.saved,
        reason: status.assistedLearning.lastRun.reason,
      },
      {
        result: "ran",
        saved: 1,
        reason: "1 candidate dropped: citations did not verify or exceeded the limit.",
      },
    );
    const recalled = yield* knowledge.search({
      projectId,
      query: "snake_case API responses",
      requestId: CommandId.make("learning-search"),
    });
    assert.deepEqual(
      recalled.facts.state === "available" ? recalled.facts.matches.map((m) => m.fact.id) : [],
      [fact.id],
    );
    const { history } = yield* knowledge.readFact({ projectId, factId: fact.id });
    assert.deepEqual(
      history.map((entry) => entry.event),
      ["created"],
    );
  }).pipe(Effect.provide(makeLayer(model.generate)));
});

it.effect("marks candidates from a failed run with that outcome", () => {
  const model = scripted([{ candidates: [snakeCase] }]);
  return Effect.gen(function* () {
    yield* seedRun;
    const runner = yield* AssistedLearningRunner;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    yield* runner.extractRun({ threadId, runId, runOutcome: "failed" });
    assert.equal(model.calls[0]!.runOutcome, "failed");
    const { facts } = yield* knowledge.list({ projectId, status: "saved" });
    assert.deepEqual(
      facts.map((fact) => [fact.status, fact.origin.kind === "assisted" && fact.origin.runOutcome]),
      [["saved", "failed"]],
    );
  }).pipe(Effect.provide(makeLayer(model.generate)));
});

it.effect(
  "skips exact duplicates and saves different facts without replacing existing ones",
  () => {
    const conflict = "The primary database store switched to Postgres instead of MySQL.";
    const model = scripted([
      {
        candidates: [
          { ...snakeCase, content: "API responses use snake_case keys for every public endpoint." },
          { ...snakeCase, content: "Tests run with vp test." },
          { ...snakeCase, content: conflict },
        ],
      },
    ]);
    return Effect.gen(function* () {
      yield* seedRun;
      const runner = yield* AssistedLearningRunner;
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const create = (id: string, content: string) => ({
        action: "create" as const,
        commandId: CommandId.make(id),
        projectId,
        factId: ProjectFactId.make(id),
        content,
        entities: [],
        tags: [],
        kind: "convention" as const,
        sources: [{ kind: "user" as const }],
      });
      const seed = (id: string, content: string) =>
        knowledge.mutate(create(id, content), { kind: "user" });
      const nearDuplicate = yield* seed(
        "near",
        "API responses use snake_case keys for every endpoint.",
      );
      yield* seed("exact", "Tests run with vp test.");
      const database = yield* seed("database", "The primary database store is MySQL or Postgres.");
      yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
      const { facts } = yield* knowledge.list({ projectId, status: "saved", origin: "assisted" });
      assert.deepEqual(
        facts.map((fact) => [fact.content, fact.supersedes ?? null]).toSorted(),
        [
          ["API responses use snake_case keys for every public endpoint.", null],
          [conflict, null],
        ].toSorted(),
      );
      const { lastRun } = (yield* knowledge.status({ projectId })).assistedLearning!;
      assert.deepEqual([lastRun?.saved, lastRun?.reason], [2, "1 duplicate skipped."]);
      for (const existing of [nearDuplicate, database]) {
        const { fact } = yield* knowledge.readFact({ projectId, factId: existing.id });
        assert.equal(fact.supersededBy ?? null, null);
        assert.equal(fact.revision, 1);
      }
      // Exact matching cannot depend on the three UI hints or the forty lexical neighbours.
      for (let index = 0; index < 101; index++) {
        yield* seed(
          `crowded-${String(index).padStart(3, "0")}`,
          `workers restart then services deploy${"!".repeat(index + 1)}`,
        );
      }
      yield* seed("z-crowded-exact", "deploy services then restart workers");
      yield* seed("unicode-exact", "测试需要先运行单元测试。");
      for (const [index, content] of [
        "  DEPLOY   services then RESTART workers\n",
        "测试需要先运行单元测试。",
      ].entries()) {
        const result = yield* knowledge.saveAutomatic(
          { ...create(`crowded-auto-${index}`, content), sources: facts[0]!.sources },
          { kind: "assisted", threadId, runId, runOutcome: "completed" },
        );
        assert.equal(result.outcome, "duplicate");
      }
      const recalled = yield* knowledge.search({
        projectId,
        query: "primary database store",
        requestId: CommandId.make("recall-conflict"),
      });
      assert.deepEqual(
        recalled.facts.state === "available"
          ? recalled.facts.matches.map((match) => match.fact.id).toSorted()
          : [],
        [database.id, facts.find((fact) => fact.content === conflict)!.id].toSorted(),
      );

      const positive = yield* seed(
        "positive",
        "API responses use snake_case keys for every public endpoint.",
      );
      yield* seed("retries", "The worker pool never retries failed jobs.");
      yield* seed("approval", "Deploys require a manual approval step.");
      yield* seed("blocked", "The worker is not idle but is blocked.");
      yield* seed("enabled", "The worker pool is enabled for every public endpoint.");
      const negated = "API responses do not use snake_case keys for every public endpoint.";
      const outcomes = yield* Effect.forEach(
        [
          negated,
          negated,
          "API responses do not use snake_case keys for every single public endpoint.",
          "The worker pool retries failed jobs.",
          "Deploys don't require a manual approval step.",
          "The worker is idle but is not blocked.",
          "The worker pool is disabled for every public endpoint.",
        ],
        (content, index) =>
          knowledge
            .saveAutomatic(
              { ...create(`negation-${index}`, content), sources: facts[0]!.sources },
              { kind: "assisted", threadId, runId, runOutcome: "completed" },
            )
            .pipe(Effect.map((result) => result.outcome)),
      );
      assert.deepEqual(outcomes, [
        "saved",
        "duplicate",
        "saved",
        "saved",
        "saved",
        "saved",
        "saved",
      ]);
      const { fact: kept } = yield* knowledge.readFact({ projectId, factId: positive.id });
      assert.deepEqual(
        [kept.revision, kept.supersededBy ?? null, kept.supersedes ?? null],
        [1, null, null],
      );
    }).pipe(Effect.provide(makeLayer(model.generate)));
  },
);

const testsCommand = {
  kind: "convention" as const,
  content: "Tests run with vp test.",
  entities: [],
  citations: ["M2"],
};

it.effect("does not bring back a forgotten fact when the job runs again", () => {
  // The retried model call returns the same candidate at a different position.
  const model = scripted([{ candidates: [snakeCase] }, { candidates: [testsCommand, snakeCase] }]);
  return Effect.gen(function* () {
    yield* seedRun;
    const runner = yield* AssistedLearningRunner;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const sql = yield* SqlClient.SqlClient;
    yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
    const [saved] = (yield* knowledge.list({ projectId, status: "saved" })).facts;
    yield* knowledge.mutate(
      {
        action: "forget",
        commandId: CommandId.make("forget-saved"),
        projectId,
        factId: saved!.id,
        expectedRevision: saved!.revision,
      },
      { kind: "user" },
    );
    // A job lost before it recorded its outcome reruns and gets the same reply.
    yield* sql`DELETE FROM project_knowledge_assisted_runs`;
    yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
    assert.equal(model.calls.length, 2);
    assert.deepEqual(
      (yield* knowledge.list({ projectId, status: "saved" })).facts.map((fact) => fact.content),
      [testsCommand.content],
    );
    assert.deepEqual(
      (yield* knowledge.list({ projectId, status: "forgotten" })).facts.map((fact) => fact.id),
      [saved!.id],
    );
  }).pipe(Effect.provide(makeLayer(model.generate)));
});

it.effect("commits a run's facts only together with its outcome", () => {
  const model = scripted([{ candidates: [snakeCase, testsCommand] }]);
  return Effect.gen(function* () {
    yield* seedRun;
    const runner = yield* AssistedLearningRunner;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const sql = yield* SqlClient.SqlClient;
    const savedContent = Effect.map(knowledge.list({ projectId, status: "saved" }), (listed) =>
      listed.facts.map((fact) => fact.content).toSorted(),
    );
    yield* sql`CREATE TEMP TRIGGER lose_outcome BEFORE INSERT ON project_knowledge_assisted_runs
      BEGIN SELECT RAISE(ABORT, 'outcome lost'); END`;
    const lost = yield* runner
      .extractRun({ threadId, runId, runOutcome: "completed" })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(lost));
    // Nothing a user could edit or forget exists without the outcome.
    assert.deepEqual(yield* savedContent, []);
    yield* sql`DROP TRIGGER lose_outcome`;
    yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
    assert.deepEqual(yield* savedContent, [snakeCase.content, testsCommand.content].toSorted());
    assert.equal((yield* knowledge.status({ projectId })).assistedLearning?.lastRun?.saved, 2);
  }).pipe(Effect.provide(makeLayer(model.generate)));
});

it.effect("saves nothing for a run another attempt finished while the model ran", () => {
  let finishElsewhere: Effect.Effect<void> = Effect.void;
  const generate: Generate = () =>
    Effect.suspend(() => finishElsewhere).pipe(Effect.as({ candidates: [snakeCase] }));
  return Effect.gen(function* () {
    yield* seedRun;
    const runner = yield* AssistedLearningRunner;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    finishElsewhere = knowledge
      .recordAssistedRun(projectId, {
        threadId,
        runId,
        runOutcome: "completed",
        result: "ran",
        reason: null,
        saved: 0,
        at: DateTime.formatIso(at),
      })
      .pipe(Effect.orDie);
    yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
    assert.deepEqual((yield* knowledge.list({ projectId, status: "saved" })).facts, []);
  }).pipe(Effect.provide(makeLayer(generate)));
});

it.effect("drops a candidate citing more messages than a fact may carry", () => {
  const model = scripted([
    {
      candidates: [
        { ...snakeCase, citations: Array.from({ length: 18 }, (_, index) => `M${index + 1}`) },
        testsCommand,
      ],
    },
  ]);
  return Effect.gen(function* () {
    yield* seedRun;
    yield* seedReplies(20);
    const runner = yield* AssistedLearningRunner;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
    assert.deepEqual(
      (yield* knowledge.list({ projectId, status: "saved" })).facts.map((fact) => fact.content),
      [testsCommand.content],
    );
    const lastRun = (yield* knowledge.status({ projectId })).assistedLearning?.lastRun;
    assert.deepEqual(
      [lastRun?.result, lastRun?.saved, lastRun?.reason],
      ["ran", 1, "1 candidate dropped: citations did not verify or exceeded the limit."],
    );
  }).pipe(Effect.provide(makeLayer(model.generate)));
});

it.effect("records skipped and failed outcomes without saving anything", () => {
  const failing = scripted([
    new TextGenerationError({ operation: "generateKnowledgeCandidates", detail: "Rate limited." }),
  ]);
  return Effect.gen(function* () {
    yield* seedRun;
    const runner = yield* AssistedLearningRunner;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
    const lastRun = (yield* knowledge.status({ projectId })).assistedLearning?.lastRun;
    assert.deepEqual([lastRun?.result, lastRun?.reason], ["failed", "Rate limited."]);
    assert.deepEqual((yield* knowledge.list({ projectId, status: "saved" })).facts, []);
  }).pipe(Effect.provide(makeLayer(failing.generate)));
});

it.effect("skips a run whose project turned automatic memory off before it ran", () => {
  const model = scripted([{ candidates: [snakeCase] }]);
  return Effect.gen(function* () {
    yield* seedRun;
    const runner = yield* AssistedLearningRunner;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
    assert.equal(model.calls.length, 0);
    assert.equal(
      (yield* knowledge.status({ projectId })).assistedLearning?.lastRun?.result,
      "skipped",
    );
  }).pipe(
    Effect.provide(
      makeLayer(model.generate, {
        projectSettingsOverrides: { [projectId]: { enableAssistedLearning: false } },
      }),
    ),
  );
});
