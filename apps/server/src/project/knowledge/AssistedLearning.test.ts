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
  TurnItemId,
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
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as ManagedProjectFolders from "../ManagedProjectFolders.ts";
import * as AssistedLearning from "./AssistedLearning.ts";
import { AssistedLearningRunner, assistedLearningEffects } from "./assistedLearningSchedule.ts";
import * as HolographicMemory from "./HolographicMemory.ts";
import * as ProjectKnowledge from "./ProjectKnowledge.ts";

const isTextGenerationError = Schema.is(TextGenerationError);

type Generate = TextGeneration.TextGeneration["Service"]["generateKnowledgeCandidates"];
type Check = TextGeneration.TextGeneration["Service"]["checkFactStanding"];
const allStanding: Check = (input) =>
  Effect.succeed({ verdicts: input.statements.map(() => "standing" as const) });

const projectId = ProjectId.make("learning");
const threadId = ThreadId.make("learning-thread");
const runId = RunId.make("learning-run");
const providerInstanceId = ProviderInstanceId.make("codex");
const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 1));

const makeLayer = (
  generate: Generate,
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
  check: Check = allStanding,
  canCheck = true,
  scratch = false,
) =>
  AssistedLearning.layerRunner.pipe(
    Layer.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/test-projects",
        isScratchProject: () => Effect.succeed(scratch),
      }),
    ),
    Layer.provide(
      Layer.mock(TextGeneration.TextGeneration)({
        generateKnowledgeCandidates: generate,
        checkFactStanding: check,
        curateProjectMemory: () => Effect.die("unused"),
        supportsOperation: (operation) =>
          Effect.succeed(operation !== "checkFactStanding" || canCheck),
      }),
    ),
    Layer.provideMerge(ProjectKnowledge.layer.pipe(Layer.provide(HolographicMemory.layer))),
    Layer.provideMerge(
      Layer.mergeAll(ProjectStore.layer, ProjectionStore.layer, ThreadSearch.layer),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest(settings)),
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
        runId,
        messageId: MessageId.make("learning-user"),
        digest: yield* sha256("From now on API responses use snake_case keys everywhere."),
      },
      {
        kind: "message",
        threadId,
        runId,
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

it.effect("stores what the blind check set aside without making it recallable", () => {
  const scopeLimit = {
    kind: "constraint" as const,
    content: "Keep this change limited to the API handlers.",
    entities: [],
    citations: ["M1"],
  };
  const model = scripted([{ candidates: [snakeCase, scopeLimit] }]);
  const checks: Array<Parameters<Check>[0]> = [];
  const check: Check = (input) => {
    checks.push(input);
    return Effect.succeed({ verdicts: ["standing", "task"] });
  };
  return Effect.gen(function* () {
    yield* seedRun;
    const runner = yield* AssistedLearningRunner;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
    // Only the statements reach the check, from outside the project's workspace.
    assert.equal(checks.length, 1);
    assert.deepEqual(checks[0]!.statements, [
      { kind: snakeCase.kind, content: snakeCase.content },
      { kind: scopeLimit.kind, content: scopeLimit.content },
    ]);
    assert.notEqual(checks[0]!.cwd, `/work/${projectId}`);
    const saved = (yield* knowledge.list({ projectId, status: "saved" })).facts;
    assert.deepEqual(
      saved.map((fact) => [fact.content, fact.verdict?.value, fact.verdict?.by]).toSorted(),
      [
        [snakeCase.content, "standing", "check"],
        [scopeLimit.content, "task", "check"],
      ],
    );
    assert.deepEqual(
      (yield* knowledge.list({ projectId, verdict: "set_aside" })).facts.map(
        (fact) => fact.content,
      ),
      [scopeLimit.content],
    );
    const lastRun = (yield* knowledge.status({ projectId })).assistedLearning?.lastRun;
    assert.deepEqual([lastRun?.saved, lastRun?.reason], [1, "1 set aside: 1 task note."]);
  }).pipe(Effect.provide(makeLayer(model.generate, {}, check)));
});

it.effect("saves nothing when the check fails, and retries the batch before giving up", () => {
  const model = scripted([{ candidates: [snakeCase] }]);
  let checks = 0;
  const check: Check = () => {
    checks += 1;
    return Effect.fail(
      new TextGenerationError({ operation: "checkFactStanding", detail: "Rate limited." }),
    );
  };
  return Effect.gen(function* () {
    yield* seedRun;
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(at, { minutes: 10 })));
    const runner = yield* AssistedLearningRunner;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const sql = yield* SqlClient.SqlClient;
    yield* runner.enqueueRun({ threadId, runId, runOutcome: "completed" });
    yield* TestClock.adjust("30 minutes");
    yield* runner.drainDue;
    yield* runner.drainDue;
    assert.deepEqual([model.calls.length, checks], [1, 1]);
    assert.equal((yield* knowledge.status({ projectId })).assistedLearning?.lastRun, null);
    assert.equal((yield* sql`SELECT * FROM project_knowledge_learning_queue`).length, 1);
    yield* TestClock.adjust("30 minutes");
    yield* runner.drainDue;
    yield* TestClock.adjust("30 minutes");
    yield* runner.drainDue;
    assert.deepEqual([model.calls.length, checks], [3, 3]);
    const lastRun = (yield* knowledge.status({ projectId })).assistedLearning?.lastRun;
    assert.deepEqual(
      [lastRun?.result, lastRun?.reason],
      ["failed", "Standing check failed: Rate limited."],
    );
    assert.deepEqual(yield* sql`SELECT * FROM project_knowledge_learning_queue`, []);
    assert.deepEqual((yield* knowledge.list({ projectId, status: "saved" })).facts, []);
  }).pipe(Effect.provide(makeLayer(model.generate, {}, check)));
});

it.effect("skips a batch with no model call when the provider cannot run the check", () => {
  const model = scripted([{ candidates: [snakeCase] }]);
  let checks = 0;
  const check: Check = (input) => {
    checks += 1;
    return allStanding(input);
  };
  return Effect.gen(function* () {
    yield* seedRun;
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(at, { minutes: 10 })));
    const runner = yield* AssistedLearningRunner;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const sql = yield* SqlClient.SqlClient;
    yield* runner.enqueueRun({ threadId, runId, runOutcome: "completed" });
    yield* TestClock.adjust("30 minutes");
    yield* runner.drainDue;
    assert.deepEqual([model.calls.length, checks], [0, 0]);
    const lastRun = (yield* knowledge.status({ projectId })).assistedLearning?.lastRun;
    assert.deepEqual(
      [lastRun?.result, lastRun?.reason],
      [
        "skipped",
        "The text generation model's provider can't check memories. Choose another model in Settings → Threads → Text generation.",
      ],
    );
    // Finished on the first attempt: nothing waits in the queue for a retry.
    assert.deepEqual(yield* sql`SELECT * FROM project_knowledge_learning_queue`, []);
  }).pipe(Effect.provide(makeLayer(model.generate, {}, check, false)));
});

it.effect(
  "does not capture no-project work and drains previously queued extraction without learning",
  () => {
    const model = scripted([{ candidates: [snakeCase] }]);
    return Effect.gen(function* () {
      yield* seedRun;
      const runner = yield* AssistedLearningRunner;
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const sql = yield* SqlClient.SqlClient;
      yield* runner.enqueueRun({ threadId, runId, runOutcome: "completed" });
      assert.deepEqual(yield* sql`SELECT * FROM project_knowledge_learning_queue`, []);
      yield* sql`INSERT INTO project_knowledge_learning_queue
      (project_id, root_thread_id, thread_id, run_id, run_outcome, queued_at)
      VALUES (${projectId}, ${threadId}, ${threadId}, ${runId}, 'completed', 0)`;
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(at, { hours: 1 })));
      yield* runner.drainDue;
      assert.deepEqual(yield* sql`SELECT * FROM project_knowledge_learning_queue`, []);
      assert.equal(model.calls.length, 0);
      assert.deepEqual((yield* knowledge.list({ projectId, status: "saved" })).facts, []);
      const lastRun = (yield* knowledge.status({ projectId })).assistedLearning?.lastRun;
      assert.equal(lastRun?.result, "skipped");
      assert.equal(lastRun?.reason, "Automatic memory is off for threads without a project.");
    }).pipe(Effect.provide(makeLayer(model.generate, {}, allStanding, true, true)));
  },
);

/** Marks a message as a peer's reply, as a group conversation's published turn item does. */
const speakAsPeer = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly messageId: string;
  readonly text: string;
}) =>
  Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
    projections.apply({
      id: EventId.make(`peer:${input.messageId}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      providerInstanceId,
      occurredAt: at,
      payload: {
        id: TurnItemId.make(`peer-item:${input.messageId}`),
        threadId: input.threadId,
        runId: input.runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 2,
        status: "completed",
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        type: "assistant_message",
        messageId: MessageId.make(input.messageId),
        text: input.text,
        streaming: false,
        speaker: { label: "Astra", model: "gpt-6-astra" },
      },
    }),
  );

it.effect("sends a peer reply as that peer, not as the assistant", () => {
  const model = scripted([{ candidates: [] }]);
  const text = "Done. I converted the handlers to snake_case keys.";
  return Effect.gen(function* () {
    yield* seedRun;
    yield* speakAsPeer({ threadId, runId, messageId: "learning-reply", text });
    const runner = yield* AssistedLearningRunner;
    yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
    assert.deepEqual(model.calls[0]?.messages[1], {
      ref: "M2",
      role: "peer",
      speaker: { label: "Astra", model: "gpt-6-astra" },
      threadId,
      runId,
      runOutcome: "completed",
      text,
    });
  }).pipe(Effect.provide(makeLayer(model.generate)));
});

it.effect.each([
  { senderThreadId: ThreadId.make("coordinator") },
  {
    linkedSender: {
      environmentId: EnvironmentId.make("linked-environment"),
      threadId: ThreadId.make("coordinator"),
      title: "Coordinator",
    },
  },
  {},
])("keeps an agent delivery separate from human learning evidence: %j", (sender) => {
  const model = scripted([{ candidates: [] }]);
  return Effect.gen(function* () {
    yield* seedRun;
    yield* seedReplies(1);
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const records = yield* projections.getThreadRecords(threadId, ["messages"]);
    const reply = records.messages.find((message) => message.id === "learning-reply")!;
    yield* projections.apply({
      id: EventId.make("agent-delivery"),
      type: "message.updated",
      threadId,
      providerInstanceId,
      occurredAt: reply.createdAt,
      payload: {
        ...reply,
        ...sender,
        role: "user",
        createdBy: "agent",
        creationSource: "mcp",
        text: "For future tasks, the coordinator proposes disabling integration tests.",
      },
    });
    const runner = yield* AssistedLearningRunner;
    yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
    const messages = model.calls[0]!.messages;
    assert.equal(messages[0]!.role, "user");
    assert.notEqual(messages[1]!.role, "user");
    assert.include(messages[1]!.text, "coordinator proposes");
  }).pipe(Effect.provide(makeLayer(model.generate)));
});

it.effect.each([
  { senderThreadId: ThreadId.make("coordinator") },
  {
    linkedSender: {
      environmentId: EnvironmentId.make("linked-environment"),
      threadId: ThreadId.make("coordinator"),
      title: "Coordinator",
    },
  },
])("does not count a forwarded report in two threads as independent evidence: %j", (sender) => {
  const generate: Generate = (input) =>
    Effect.succeed({
      candidates: [
        {
          kind: "convention",
          content: "Disable integration tests in all future work.",
          entities: ["tests"],
          citations: input.messages
            .filter((message) => message.text.includes("coordinator proposes"))
            .map((message) => message.ref),
        },
      ],
    });
  return Effect.gen(function* () {
    yield* seedRun;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runner = yield* AssistedLearningRunner;
    const records = yield* projections.getThreadRecords(threadId, ["messages"]);
    const baseMessage = records.messages[0]!;
    const childId = ThreadId.make("learning-child");
    yield* projections.apply({
      id: EventId.make("create-child"),
      type: "thread.created",
      threadId: childId,
      providerInstanceId,
      occurredAt: at,
      payload: {
        ...records.thread,
        id: childId,
        lineage: {
          parentThreadId: threadId,
          rootThreadId: threadId,
          relationshipToParent: "subagent",
        },
      },
    });
    for (const [index, receiver] of [threadId, childId].entries()) {
      const forwardedRunId = RunId.make(`forwarded-run-${index}`);
      for (const role of ["user", "assistant"] as const) {
        const id = MessageId.make(`forwarded-${index}-${role}`);
        const createdAt = DateTime.add(at, {
          minutes: 5 + index * 2 + (role === "assistant" ? 1 : 0),
        });
        yield* projections.apply({
          id: EventId.make(`message:${id}`),
          type: "message.updated",
          threadId: receiver,
          providerInstanceId,
          occurredAt: createdAt,
          payload: {
            ...baseMessage,
            ...(role === "user" ? sender : {}),
            id,
            threadId: receiver,
            runId: forwardedRunId,
            role,
            createdBy: "agent",
            creationSource: role === "user" ? "mcp" : "provider",
            text:
              role === "user"
                ? `The coordinator proposes disabling integration tests for future work. Update ${index}.`
                : `I will investigate report ${index}.`,
            createdAt,
            updatedAt: createdAt,
          },
        });
      }
      yield* runner.enqueueRun({
        threadId: receiver,
        runId: forwardedRunId,
        runOutcome: "completed",
      });
    }
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(at, { hours: 1 })));
    yield* runner.drainDue;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    assert.deepEqual((yield* knowledge.list({ projectId, status: "saved" })).facts, []);
  }).pipe(Effect.provide(makeLayer(generate)));
});

it.effect(
  "saves no peer words the user never cited, though the seat's own thread repeats them",
  () => {
    const decision = {
      kind: "decision" as const,
      content: "Sessions move from Redis to Postgres.",
      entities: ["sessions"],
      citations: ["M1", "M2"],
    };
    const model = scripted([{ candidates: [decision, { ...decision, kind: "convention" }] }]);
    return Effect.gen(function* () {
      yield* seedRun;
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(at, { minutes: 10 })));
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const records = yield* projections.getThreadRecords(threadId, []);
      const seatId = ThreadId.make("learning-seat");
      yield* projections.apply({
        id: EventId.make("create-seat"),
        type: "thread.created",
        threadId: seatId,
        providerInstanceId,
        occurredAt: at,
        payload: {
          ...records.thread,
          id: seatId,
          lineage: {
            parentThreadId: threadId,
            rootThreadId: threadId,
            relationshipToParent: "subagent",
          },
        },
      });
      const runner = yield* AssistedLearningRunner;
      const replies = [
        [threadId, "peer-root", "Drop Redis and move sessions to Postgres."],
        [seatId, "peer-seat", "I recommend Postgres for sessions instead of Redis."],
      ] as const;
      for (const [index, [replyThreadId, id, text]] of replies.entries()) {
        const replyRunId = RunId.make(`${id}-run`);
        yield* projections.apply({
          id: EventId.make(`message:${id}`),
          type: "message.updated",
          threadId: replyThreadId,
          providerInstanceId,
          occurredAt: DateTime.add(at, { minutes: index }),
          payload: {
            id: MessageId.make(id),
            threadId: replyThreadId,
            runId: replyRunId,
            nodeId: null,
            role: "assistant",
            text,
            attachments: [],
            streaming: false,
            createdAt: DateTime.add(at, { minutes: index }),
            updatedAt: at,
            createdBy: "agent",
            creationSource: "provider",
          },
        });
        if (replyThreadId === threadId) {
          yield* projections.apply({
            id: EventId.make(`run:${id}`),
            type: "run.created",
            threadId,
            providerInstanceId,
            occurredAt: at,
            payload: {
              id: replyRunId,
              threadId,
              ordinal: 2,
              providerInstanceId,
              modelSelection: { instanceId: providerInstanceId, model: "gpt-6-astra" },
              providerThreadId: null,
              userMessageId: MessageId.make(id),
              rootNodeId: null,
              activeAttemptId: null,
              status: "completed",
              requestedAt: at,
              startedAt: at,
              completedAt: at,
              checkpointId: null,
              contextHandoffId: null,
              publication: {
                type: "peer_reply",
                seatThreadId: seatId,
                seatRunId: RunId.make("peer-seat-run"),
              },
            },
          });
          yield* speakAsPeer({ threadId, runId: replyRunId, messageId: id, text });
        }
        yield* runner.enqueueRun({
          threadId: replyThreadId,
          runId: replyRunId,
          runOutcome: "completed",
        });
      }
      yield* TestClock.adjust("31 minutes");
      yield* runner.drainDue;
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const { facts } = yield* knowledge.list({ projectId, status: "saved" });
      assert.deepEqual(facts, []);
    }).pipe(Effect.provide(makeLayer(model.generate)));
  },
);

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
          "standing",
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
              "standing",
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
  content: "API field names use snake_case.",
  entities: [],
  citations: ["M1"],
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
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(at, { hours: 1 })));
    const runner = yield* AssistedLearningRunner;
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const sql = yield* SqlClient.SqlClient;
    const savedContent = Effect.map(knowledge.list({ projectId, status: "saved" }), (listed) =>
      listed.facts.map((fact) => fact.content).toSorted(),
    );
    yield* sql`CREATE TEMP TRIGGER lose_outcome BEFORE INSERT ON project_knowledge_assisted_runs
      BEGIN SELECT RAISE(ABORT, 'outcome lost'); END`;
    yield* runner.enqueueRun({ threadId, runId, runOutcome: "completed" });
    yield* TestClock.adjust("30 minutes");
    const lost = yield* runner.drainDue.pipe(Effect.result);
    assert.isTrue(Result.isFailure(lost));
    // Nothing a user could edit or forget exists without the outcome.
    assert.deepEqual(yield* savedContent, []);
    assert.equal((yield* sql`SELECT * FROM project_knowledge_learning_queue`).length, 1);
    yield* sql`DROP TRIGGER lose_outcome`;
    yield* runner.drainDue;
    assert.deepEqual(yield* sql`SELECT * FROM project_knowledge_learning_queue`, []);
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

it.effect(
  "waits for family inactivity, resumes its durable queue, and never reviews old evidence twice",
  () => {
    const model = scripted([{ candidates: [snakeCase] }]);
    return Effect.gen(function* () {
      yield* seedRun;
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(at, { minutes: 10 })));
      const runner = yield* AssistedLearningRunner;
      const sql = yield* SqlClient.SqlClient;
      yield* runner.enqueueRun({ threadId, runId, runOutcome: "completed" });
      yield* runner.enqueueRun({ threadId, runId, runOutcome: "completed" });
      yield* runner.drainDue;
      assert.equal(model.calls.length, 0);
      assert.equal((yield* sql`SELECT * FROM project_knowledge_learning_queue`).length, 1);
      yield* TestClock.adjust("30 minutes");
      yield* runner.drainDue;
      assert.equal(model.calls.length, 1);
      assert.deepEqual(yield* sql`SELECT * FROM project_knowledge_learning_queue`, []);
      yield* runner.enqueueRun({ threadId, runId, runOutcome: "completed" });
      yield* TestClock.adjust("30 minutes");
      yield* runner.drainDue;
      assert.equal(model.calls.length, 1);
    }).pipe(Effect.provide(makeLayer(model.generate)));
  },
);

it.effect(
  "batches eight new runs across a root and its child, retaining each citation's provenance",
  () => {
    const incident = {
      kind: "constraint" as const,
      content: "Service restarts delete files in /tmp, so never put work there.",
      entities: ["/tmp"],
      citations: ["M2", "M3"],
    };
    const model = scripted([
      {
        candidates: [{ ...snakeCase, citations: ["M1", "M8"] }, incident],
      },
    ]);
    return Effect.gen(function* () {
      yield* seedRun;
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(at, { minutes: 10 })));
      const runner = yield* AssistedLearningRunner;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const records = yield* projections.getThreadRecords(threadId, []);
      const childId = ThreadId.make("learning-child");
      yield* projections.apply({
        id: EventId.make("create-child"),
        type: "thread.created",
        threadId: childId,
        providerInstanceId,
        occurredAt: at,
        payload: {
          ...records.thread,
          id: childId,
          lineage: {
            parentThreadId: threadId,
            rootThreadId: threadId,
            relationshipToParent: "subagent",
          },
        },
      });
      for (let index = 0; index < 8; index += 1) {
        const sourceThreadId = index % 2 === 0 ? threadId : childId;
        const sourceRunId = RunId.make(`batch-run-${index}`);
        yield* projections.apply({
          id: EventId.make(`batch-message-${index}`),
          type: "message.updated",
          threadId: sourceThreadId,
          providerInstanceId,
          occurredAt: DateTime.add(at, { minutes: index }),
          payload: {
            id: MessageId.make(`batch-message-${index}`),
            threadId: sourceThreadId,
            runId: sourceRunId,
            nodeId: null,
            role: index === 0 ? "user" : "assistant",
            text:
              index === 1 || index === 2
                ? `Worker ${index}: my temporary file was missing around the service restart; I have not confirmed what removed it.`
                : `API responses use snake_case keys ${index}.`,
            attachments: [],
            streaming: false,
            createdAt: DateTime.add(at, { minutes: index }),
            updatedAt: at,
            createdBy: index === 0 ? "user" : "agent",
            creationSource: "web",
          },
        });
        yield* runner.enqueueRun({
          threadId: sourceThreadId,
          runId: sourceRunId,
          runOutcome: "completed",
        });
        assert.equal(model.calls.length, 0);
      }
      yield* runner.drainDue;
      assert.equal(model.calls.length, 1);
      assert.equal(model.calls[0]!.messages.length, 8);
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const { facts } = yield* knowledge.list({ projectId, status: "saved" });
      assert.equal(facts.length, 2);
      const observation = facts.find((fact) => fact.kind === "note")!;
      assert.equal(observation.content, `Unverified agent report: ${incident.content}`);
      assert.equal(observation.kind, "note");
      assert.equal(observation.verdict?.value, "task");
      assert.equal(
        facts.find((fact) => fact.content === snakeCase.content)?.verdict?.value,
        "standing",
      );
      assert.deepEqual(
        facts
          .find((fact) => fact.content === snakeCase.content)!
          .sources.map((source) => source.kind === "message" && [source.threadId, source.runId]),
        [
          [threadId, RunId.make("batch-run-0")],
          [childId, RunId.make("batch-run-7")],
        ],
      );
    }).pipe(Effect.provide(makeLayer(model.generate)));
  },
);

it.effect("resets the idle window when the family receives new work", () => {
  const model = scripted([{ candidates: [snakeCase] }]);
  return Effect.gen(function* () {
    yield* seedRun;
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(at, { minutes: 10 })));
    const runner = yield* AssistedLearningRunner;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* runner.enqueueRun({ threadId, runId, runOutcome: "completed" });
    yield* TestClock.adjust("20 minutes");
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("new-family-work"),
      type: "message.updated",
      threadId,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: MessageId.make("new-family-work"),
        threadId,
        runId: RunId.make("next-run"),
        nodeId: null,
        role: "user",
        text: "Continue working on the API.",
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
        createdBy: "user",
        creationSource: "web",
      },
    });
    yield* TestClock.adjust("10 minutes");
    yield* runner.drainDue;
    assert.equal(model.calls.length, 0);
    yield* TestClock.adjust("20 minutes");
    yield* runner.drainDue;
    assert.equal(model.calls.length, 1);
    assert.equal(model.calls[0]!.messages.length, 2);
  }).pipe(Effect.provide(makeLayer(model.generate)));
});

it.effect(
  "drops unsupported assistant-only claims and terminal model failures without a retry storm",
  () => {
    const model = scripted([
      { candidates: [{ ...snakeCase, citations: ["M2"] }] },
      new TextGenerationError({
        operation: "generateKnowledgeCandidates",
        detail: "Provider quota exhausted",
      }),
    ]);
    return Effect.gen(function* () {
      yield* seedRun;
      const runner = yield* AssistedLearningRunner;
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
      assert.deepEqual((yield* knowledge.list({ projectId, status: "saved" })).facts, []);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM project_knowledge_assisted_runs`;
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(at, { hours: 1 })));
      yield* runner.enqueueRun({ threadId, runId, runOutcome: "completed" });
      yield* TestClock.adjust("30 minutes");
      yield* runner.drainDue;
      yield* TestClock.adjust("30 minutes");
      yield* runner.drainDue;
      assert.equal(model.calls.length, 2);
      assert.equal(
        (yield* knowledge.status({ projectId })).assistedLearning?.lastRun?.result,
        "failed",
      );
      assert.deepEqual(yield* sql`SELECT * FROM project_knowledge_learning_queue`, []);
    }).pipe(Effect.provide(makeLayer(model.generate)));
  },
);

it.effect(
  "receipts bounded pending chunks when a project opts out, without reading them into a model",
  () => {
    const model = scripted([{ candidates: [snakeCase] }]);
    return Effect.gen(function* () {
      yield* seedRun;
      const runner = yield* AssistedLearningRunner;
      yield* runner.enqueueRun({ threadId, runId, runOutcome: "completed" });
      const sql = yield* SqlClient.SqlClient;
      for (let index = 0; index < 9; index += 1)
        yield* sql`INSERT INTO project_knowledge_learning_queue
        (project_id, root_thread_id, thread_id, run_id, run_outcome, queued_at)
        VALUES (${projectId}, ${threadId}, ${threadId}, ${`opt-out-${index}`}, 'completed', 0)`;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        projectSettingsOverrides: { [projectId]: { enableAssistedLearning: false } },
      });
      yield* runner.drainDue;
      assert.equal(model.calls.length, 0);
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      assert.equal(
        (yield* knowledge.status({ projectId })).assistedLearning?.lastRun?.result,
        "skipped",
      );
      assert.equal((yield* sql`SELECT * FROM project_knowledge_learning_queue`).length, 2);
      assert.equal((yield* sql`SELECT * FROM project_knowledge_assisted_runs`).length, 8);
      yield* runner.drainDue;
      assert.deepEqual(yield* sql`SELECT * FROM project_knowledge_learning_queue`, []);
    }).pipe(Effect.provide(makeLayer(model.generate)));
  },
);

it.effect("resumes a persisted idle family after restart without a new run event", () => {
  const model = scripted([{ candidates: [snakeCase] }]);
  return Effect.gen(function* () {
    yield* seedRun;
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(at, { hours: 1 })));
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO project_knowledge_learning_queue
      (project_id, root_thread_id, thread_id, run_id, run_outcome, queued_at)
      VALUES (${projectId}, ${threadId}, ${threadId}, ${runId}, 'completed', ${DateTime.toEpochMillis(at)})`;
    const runner = yield* AssistedLearningRunner;
    yield* runner.drainDue;
    yield* runner.drainDue;
    assert.equal(model.calls.length, 1);
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    assert.equal((yield* knowledge.list({ projectId, status: "saved" })).facts.length, 1);
    assert.deepEqual(yield* sql`SELECT * FROM project_knowledge_learning_queue`, []);
  }).pipe(Effect.provide(makeLayer(model.generate)));
});

it.effect.each(["missing", "deleted", "moved"] as const)(
  "consumes a %s queue head and attributes sibling facts to their interrupted source run",
  (state) => {
    const model = scripted([{ candidates: [snakeCase] }]);
    return Effect.gen(function* () {
      yield* seedRun;
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(at, { hours: 1 })));
      const sql = yield* SqlClient.SqlClient;
      const missingRun = RunId.make("missing-run");
      if (state !== "missing") {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const records = yield* projections.getThreadRecords(threadId, []);
        yield* projections.apply({
          id: EventId.make("unavailable-head"),
          type: "thread.created",
          threadId: ThreadId.make("missing-thread"),
          providerInstanceId,
          occurredAt: at,
          payload: {
            ...records.thread,
            id: ThreadId.make("missing-thread"),
            projectId: state === "moved" ? ProjectId.make("another-project") : projectId,
            deletedAt: state === "deleted" ? at : null,
          },
        });
      }
      yield* sql`INSERT INTO project_knowledge_learning_queue
      (project_id, root_thread_id, thread_id, run_id, run_outcome, queued_at) VALUES
      (${projectId}, ${threadId}, 'missing-thread', ${missingRun}, 'failed', 0),
      (${projectId}, ${threadId}, ${threadId}, ${runId}, 'interrupted', 1)`;
      const runner = yield* AssistedLearningRunner;
      yield* runner.drainDue;
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const { facts } = yield* knowledge.list({ projectId, status: "saved" });
      assert.equal(facts.length, 1);
      assert.deepEqual(facts[0]!.origin, {
        kind: "assisted",
        threadId,
        runId,
        runOutcome: "interrupted",
      });
      assert.deepEqual(
        yield* sql`SELECT run_id, result, saved FROM project_knowledge_assisted_runs ORDER BY run_id`,
        [
          { run_id: runId, result: "ran", saved: 1 },
          { run_id: missingRun, result: "skipped", saved: 0 },
        ],
      );
      assert.deepEqual(yield* sql`SELECT * FROM project_knowledge_learning_queue`, []);
      assert.equal(model.calls[0]!.messages[0]!.runOutcome, "interrupted");
    }).pipe(Effect.provide(makeLayer(model.generate)));
  },
);

it.effect(
  "avoids a model call for uncorroborated assistant-only evidence and caps every transcript slice",
  () => {
    const model = scripted([{ candidates: [] }]);
    return Effect.gen(function* () {
      yield* seedRun;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = json_set(payload_json, '$.createdBy', 'agent') WHERE message_id = 'learning-user'`;
      const runner = yield* AssistedLearningRunner;
      yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
      assert.equal(model.calls.length, 0);
      yield* sql`DELETE FROM project_knowledge_assisted_runs`;
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = json_set(payload_json, '$.createdBy', 'user') WHERE message_id = 'learning-user'`;
      yield* seedReplies(10);
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = json_set(payload_json, '$.text', ${"x".repeat(6_000)}) WHERE role = 'assistant'`;
      const correction = "From now on, explain the cause before proposing a fix.";
      yield* sql`UPDATE orchestration_v2_projection_messages SET role = 'user', payload_json = json_set(payload_json, '$.role', 'user', '$.createdBy', 'user', '$.text', ${correction}) WHERE message_id = 'learning-extra-0'`;
      yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
      assert.equal(model.calls.length, 1);
      assert.isTrue(model.calls[0]!.messages.some((message) => message.text === correction));
      assert.isAtMost(
        model.calls[0]!.messages.reduce((total, message) => total + message.text.length, 0),
        32_000,
      );
      assert.isTrue(model.calls[0]!.messages.every((message) => message.text.length <= 6_000));
    }).pipe(Effect.provide(makeLayer(model.generate)));
  },
);

it.effect.each([" OK! ", "Thanks.", "continue...", "HELLO", "Use Bun."])(
  "requires meaningful human evidence before paying for a singleton review: %s",
  (text) => {
    const model = scripted([{ candidates: [] }]);
    return Effect.gen(function* () {
      yield* seedRun;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = json_set(payload_json, '$.text', ${text}) WHERE message_id = 'learning-user'`;
      const runner = yield* AssistedLearningRunner;
      yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
      assert.equal(model.calls.length, text === "Use Bun." ? 1 : 0);
    }).pipe(Effect.provide(makeLayer(model.generate)));
  },
);

it.effect("dequeues stale completed entries without touching their existing receipts", () => {
  const model = scripted([{ candidates: [snakeCase] }]);
  return Effect.gen(function* () {
    yield* seedRun;
    const runner = yield* AssistedLearningRunner;
    yield* runner.extractRun({ threadId, runId, runOutcome: "completed" });
    const sql = yield* SqlClient.SqlClient;
    const before = yield* sql`SELECT * FROM project_knowledge_assisted_runs`;
    yield* runner.enqueueRun({ threadId, runId, runOutcome: "failed" });
    assert.deepEqual(yield* sql`SELECT * FROM project_knowledge_learning_queue`, []);
    yield* sql`INSERT INTO project_knowledge_learning_queue
      (project_id, root_thread_id, thread_id, run_id, run_outcome, queued_at)
      VALUES (${projectId}, ${threadId}, ${threadId}, ${runId}, 'failed', 0)`;
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.add(at, { hours: 1 })));
    yield* runner.drainDue;
    assert.deepEqual(yield* sql`SELECT * FROM project_knowledge_assisted_runs`, before);
    assert.deepEqual(yield* sql`SELECT * FROM project_knowledge_learning_queue`, []);
    assert.equal(model.calls.length, 1);
  }).pipe(Effect.provide(makeLayer(model.generate)));
});
