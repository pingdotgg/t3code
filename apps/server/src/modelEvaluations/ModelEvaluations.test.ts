import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ServerProvider,
  RunId,
  TextGenerationError,
  ThreadId,
  TurnItemId,
  type ModelEvaluationVerdict,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ModelEvaluations from "./ModelEvaluations.ts";

type Generate = TextGeneration.TextGeneration["Service"]["generateModelEvaluation"];
const projectId = ProjectId.make("evaluation-project");
const threadId = ThreadId.make("evaluation-thread");
const instanceId = ProviderInstanceId.make("opencode");
const runId = RunId.make("evaluation-run");
const modelSelection = { instanceId, model: "deepseek/deepseek-v4" };
const at = DateTime.makeUnsafe(-60_000);
const scope = { projectId };
const input = { threadId, runId, runOutcome: "completed" as const };
const decodeProvider = Schema.decodeSync(ServerProvider);

const makeLayer = (
  generate: Generate,
  enabled = true,
  published: ReadonlyArray<ServerProvider> = [],
) =>
  ModelEvaluations.layer.pipe(
    Layer.provide(Layer.mock(TextGeneration.TextGeneration)({ generateModelEvaluation: generate })),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getPublishedProviders: Effect.succeed(published),
      }),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        ProjectStore.layer,
        ProjectionStore.layer,
        EventStore.layer,
        EffectOutbox.layer,
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest({ enableModelEvaluations: enabled })),
    Layer.provideMerge(NodeServices.layer),
  );

function verdict(packet: Parameters<Generate>[0]["packet"]): ModelEvaluationVerdict {
  return {
    outcome: "scored",
    taskCategory: "coding",
    confidence: "medium",
    scores: { taskCompletion: 3, correctness: 3, instructionFollowing: 4, verification: null },
    rationale: {
      text: "The result addresses the requested change; execution evidence is unavailable.",
      citations: ["U1", packet.evidence.at(-1)!.ref],
    },
    strengths: [
      {
        text: "The explicit acceptance criterion was addressed.",
        citations: [packet.evidence.at(-1)!.ref],
      },
    ],
    weaknesses: [],
    promptAdvice: [{ text: "Keep the acceptance criterion explicit.", citations: ["U1"] }],
  };
}

const persist = Effect.fn("test.persistEvaluationEvent")(function* (
  event: OrchestrationV2DomainEvent,
) {
  yield* (yield* EventStore.EventStoreV2).append({ events: [event] });
  yield* (yield* ProjectionStore.ProjectionStoreV2).apply(event);
});

const seed = Effect.fn("test.seedEvaluationRun")(function* (
  options: {
    readonly project?: ProjectId;
    readonly thread?: ThreadId;
    readonly run?: RunId;
    readonly model?: ModelSelection;
    readonly missingReply?: boolean;
    readonly subagent?: boolean;
    readonly existingThread?: OrchestrationV2AppThread;
    readonly requestedAt?: DateTime.Utc;
  } = {},
) {
  const project = options.project ?? projectId;
  const thread = options.thread ?? threadId;
  const run = options.run ?? runId;
  const model = options.model ?? modelSelection;
  yield* (yield* ProjectStore.ProjectStoreV2).apply({
    sequence: 0,
    eventId: EventId.make(`project:${project}`),
    aggregateKind: "project",
    aggregateId: project,
    occurredAt: DateTime.formatIso(at),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId: project,
      title: "Evaluation project",
      workspaceRoot: "/private/project-with-model-config",
      defaultModelSelection: null,
      scripts: [],
      createdAt: DateTime.formatIso(at),
      updatedAt: DateTime.formatIso(at),
    },
  });
  const threadRecord: OrchestrationV2AppThread = options.existingThread ?? {
    createdBy: "user",
    creationSource: "web",
    id: thread,
    projectId: project,
    title: "A private task",
    providerInstanceId: model.instanceId,
    modelSelection: model,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: options.subagent ? ThreadId.make("parent") : null,
      relationshipToParent: options.subagent ? "subagent" : null,
      rootThreadId: thread,
    },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  if (options.existingThread === undefined)
    yield* persist({
      id: EventId.make(`thread:${thread}`),
      type: "thread.created",
      threadId: thread,
      occurredAt: at,
      payload: threadRecord,
    });
  const runRecord: OrchestrationV2Run = {
    id: run,
    threadId: thread,
    ordinal: options.existingThread ? 2 : 1,
    providerInstanceId: model.instanceId,
    modelSelection: model,
    providerThreadId: null,
    userMessageId: MessageId.make(`${run}:user`),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: options.requestedAt ?? at,
    startedAt: options.requestedAt ?? at,
    completedAt: options.requestedAt ?? at,
    checkpointId: null,
    contextHandoffId: null,
  };
  yield* persist({
    id: EventId.make(`run:${run}`),
    type: "run.updated",
    threadId: thread,
    runId: run,
    occurredAt: at,
    payload: runRecord,
  });
  const messages: OrchestrationV2ConversationMessage[] = [];
  for (const role of options.missingReply
    ? ["user" as const]
    : ["user" as const, "assistant" as const]) {
    const message: OrchestrationV2ConversationMessage = {
      id: MessageId.make(`${run}:${role}`),
      threadId: thread,
      runId: role === "user" ? null : run,
      nodeId: null,
      role,
      createdBy: role === "user" ? "user" : "agent",
      creationSource: role === "user" ? "web" : "provider",
      text:
        role === "user"
          ? "DeepSeek: add a named export and keep existing callers working."
          : "I am DeepSeek on OpenCode. Added the named export; existing callers remain compatible.",
      streaming: false,
      attachments: [],
      createdAt:
        role === "user"
          ? (options.requestedAt ?? at)
          : DateTime.add(options.requestedAt ?? at, { seconds: 1 }),
      updatedAt: at,
    };
    messages.push(message);
    yield* persist({
      id: EventId.make(`message:${run}:${role}`),
      type: "message.updated",
      threadId: thread,
      runId: run,
      occurredAt: at,
      payload: message,
    });
    const base = {
      id: TurnItemId.make(`${run}:${role}`),
      threadId: thread,
      runId: run,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: role === "user" ? 0 : 1,
      status: "completed" as const,
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      messageId: message.id,
      text: message.text,
    };
    const item: OrchestrationV2TurnItem =
      role === "user"
        ? {
            ...base,
            type: "user_message",
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            attachments: [],
          }
        : { ...base, type: "assistant_message", streaming: false };
    yield* persist({
      id: EventId.make(`item:${run}:${role}`),
      type: "turn-item.updated",
      threadId: thread,
      runId: run,
      occurredAt: at,
      payload: item,
    });
  }
  return { thread: threadRecord, run: runRecord, messages };
});

it.effect(
  "opts out without a judge call and records blinded, attributed, idempotent outcomes when enabled",
  () => {
    const calls: Array<Parameters<Generate>[0]> = [];
    return Effect.gen(function* () {
      const seeded = yield* seed({ subagent: true });
      const service = yield* ModelEvaluations.ModelEvaluations;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const effectId = `effect:model-evaluation.generate:${runId}`;
      yield* service.enqueueRun(input);
      assert.isTrue(Option.isNone(yield* outbox.get(effectId)));
      yield* service.evaluateRun(input);
      assert.equal(calls.length, 0);
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        enableModelEvaluations: true,
      });
      yield* service.enqueueRun(input);
      assert.equal(Option.getOrThrow(yield* outbox.get(effectId)).status, "pending");
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const before = yield* projections.getThreadRecords(threadId, [
        "runs",
        "messages",
        "turnItems",
      ]);
      const counts = yield* sql`SELECT
        (SELECT COUNT(*) FROM orchestration_events) AS events,
        (SELECT COUNT(*) FROM orchestration_v2_projection_threads) AS threads,
        (SELECT COUNT(*) FROM scheduled_tasks) AS scheduled`;
      yield* Effect.all([service.evaluateRun(input), service.evaluateRun(input)], {
        concurrency: "unbounded",
      });
      assert.deepEqual(
        yield* projections.getThreadRecords(threadId, ["runs", "messages", "turnItems"]),
        before,
      );
      assert.deepEqual(
        yield* sql`SELECT
        (SELECT COUNT(*) FROM orchestration_events) AS events,
        (SELECT COUNT(*) FROM orchestration_v2_projection_threads) AS threads,
        (SELECT COUNT(*) FROM scheduled_tasks) AS scheduled`,
        counts,
      );
      assert.equal(calls.length, 1);
      const sent = calls[0]!;
      assert.notInclude(sent.cwd, "private/project-with-model-config");
      assert.notMatch(
        JSON.stringify(sent.packet),
        /deepseek|opencode|evaluation-thread|evaluation-run/i,
      );
      assert.equal(sent.packet.scope, "subagent");
      assert.equal(seeded.messages[0]?.runId, null);
      const report = yield* service.list(scope);
      assert.equal(report.records.length, 1);
      assert.equal(report.records[0]?.status, "scored");
      assert.deepEqual(report.records[0]?.modelSelection, modelSelection);
      assert.equal(report.guidance[0]?.sampleCount, 1);
      assert.equal(report.guidance[0]?.scoreCounts.verification, 0);
      assert.equal(report.guidance[0]?.meanScores.verification, null);
      assert.equal(report.guidance[0]?.confidence, "provisional");
      assert.equal(report.guidance[0]?.promptChars.min, seeded.messages[0]!.text.length);
    }).pipe(
      Effect.provide(
        makeLayer((request) => {
          calls.push(request);
          return Effect.succeed(verdict(request.packet));
        }, false),
      ),
    );
  },
);

it.effect.each(["provider-error", "unsupported-citation", "abstention", "missing-reply"] as const)(
  "keeps %s separate from a low task score",
  (kind) =>
    Effect.gen(function* () {
      yield* seed({ missingReply: kind === "missing-reply" });
      const service = yield* ModelEvaluations.ModelEvaluations;
      yield* service.evaluateRun(input);
      const report = yield* service.list(scope);
      const record = report.records[0]!;
      assert.equal(
        record.status,
        kind === "missing-reply"
          ? "skipped"
          : kind === "abstention"
            ? "insufficient_evidence"
            : "failed",
      );
      assert.equal(
        report.guidance.reduce((sum, group) => sum + group.sampleCount, 0),
        0,
      );
      if (kind !== "abstention") assert.isNull(record.verdict);
    }).pipe(
      Effect.provide(
        makeLayer((request) => {
          if (kind === "provider-error")
            return Effect.fail(
              new TextGenerationError({
                operation: "generateModelEvaluation",
                detail: "Do not persist this provider payload.",
              }),
            );
          const output = verdict(request.packet);
          if (kind === "unsupported-citation")
            return Effect.succeed({
              ...output,
              rationale: { text: "Unfounded claim", citations: ["E999"] },
            });
          if (kind === "abstention")
            return Effect.succeed({
              ...output,
              outcome: "insufficient_evidence",
              confidence: "low",
              scores: {
                taskCompletion: null,
                correctness: null,
                instructionFollowing: null,
                verification: null,
              },
              strengths: [],
              weaknesses: [],
              promptAdvice: [],
            });
          return Effect.succeed(output);
        }),
      ),
    ),
);

it.effect.each(["clear", "disable", "edit", "move"] as const)(
  "does not publish a judge result after %s while it was running",
  (action) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const seeded = yield* seed();
        const service = yield* ModelEvaluations.ModelEvaluations;
        const running = yield* service.evaluateRun(input).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        if (action === "clear") yield* service.clear(scope);
        else if (action === "disable")
          yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
            enableModelEvaluations: false,
          });
        else if (action === "move")
          yield* persist({
            id: EventId.make("moved-thread"),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: at,
            payload: { ...seeded.thread, projectId: ProjectId.make("moved-project") },
          });
        else
          yield* persist({
            id: EventId.make("changed-source"),
            type: "message.updated",
            threadId,
            runId,
            occurredAt: at,
            payload: { ...seeded.messages[1]!, text: "Actually the export is missing." },
          });
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(running);
        assert.deepEqual((yield* service.list(scope)).records, []);
        assert.deepEqual(
          yield* (yield* SqlClient.SqlClient)`SELECT run_id FROM model_evaluations`,
          [],
        );
        if (action === "clear") {
          yield* service.evaluateRun(input);
          assert.deepEqual((yield* service.list(scope)).records, []);
        }
      }).pipe(
        Effect.provide(
          makeLayer((request) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(verdict(request.packet)),
            ),
          ),
        ),
      );
    }),
);

it.effect(
  "invalidates changed and rolled back sources, preserves unrelated turns, and keeps projects isolated",
  () =>
    Effect.gen(function* () {
      const seeded = yield* seed();
      const service = yield* ModelEvaluations.ModelEvaluations;
      yield* service.evaluateRun(input);
      const otherProject = ProjectId.make("other-project");
      const otherThread = ThreadId.make("other-thread");
      const otherRun = RunId.make("other-run");
      yield* seed({ project: otherProject, thread: otherThread, run: otherRun });
      yield* service.evaluateRun({
        threadId: otherThread,
        runId: otherRun,
        runOutcome: "completed",
      });
      yield* persist({
        id: EventId.make("unrelated-later-message"),
        type: "message.updated",
        threadId,
        runId: RunId.make("unrelated-run"),
        occurredAt: at,
        payload: {
          ...seeded.messages[1]!,
          id: MessageId.make("unrelated-message"),
          runId: RunId.make("unrelated-run"),
          text: "Unrelated later task.",
        },
      });
      assert.equal((yield* service.list(scope)).records.length, 1);
      yield* persist({
        id: EventId.make("same-timestamp-edit"),
        type: "message.updated",
        threadId,
        runId,
        occurredAt: at,
        payload: { ...seeded.messages[1]!, text: "Changed result at the same timestamp." },
      });
      assert.deepEqual((yield* service.list(scope)).records, []);
      assert.equal((yield* service.list({ projectId: otherProject })).records.length, 1);
      yield* service.clear(scope);
      assert.equal((yield* service.list({ projectId: otherProject })).records.length, 1);
      const other = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadRecords(
        otherThread,
        ["runs"],
      );
      yield* persist({
        id: EventId.make("rollback-other"),
        type: "run.updated",
        threadId: otherThread,
        runId: otherRun,
        occurredAt: at,
        payload: { ...other.runs[0]!, status: "rolled_back" },
      });
      assert.deepEqual((yield* service.list({ projectId: otherProject })).guidance, []);
    }).pipe(Effect.provide(makeLayer((request) => Effect.succeed(verdict(request.packet))))),
);

it.effect(
  "keeps model options and judges separate, counts observed scores, and expires old guidance",
  () =>
    Effect.gen(function* () {
      const service = yield* ModelEvaluations.ModelEvaluations;
      const settings = yield* ServerSettings.ServerSettingsService;
      for (let index = 0; index < 8; index++) {
        const id = RunId.make(`group-run-${index}`);
        const thread = ThreadId.make(`group-thread-${index}`);
        if (index === 6)
          yield* settings.updateSettings({
            modelEvaluationModelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "another-judge",
            },
          });
        yield* seed({
          thread,
          run: id,
          subagent: index === 7,
          model: {
            ...modelSelection,
            options: index === 5 ? [{ id: "effort", value: "high" }] : [],
          },
        });
        yield* service.evaluateRun({ threadId: thread, runId: id, runOutcome: "completed" });
      }
      const report = yield* service.list(scope);
      assert.equal(report.guidance.length, 4);
      const learned = report.guidance.find((group) => group.sampleCount === 5)!;
      assert.equal(learned.confidence, "observed");
      assert.equal(learned.meanScores.taskCompletion, 3);
      assert.equal(learned.scoreCounts.taskCompletion, 5);
      assert.equal(learned.scoreCounts.verification, 0);
      assert.equal(learned.strengths.length, 1);
      yield* settings.updateSettings({ enableModelEvaluations: false });
      assert.deepEqual(yield* service.guidance(scope), []);
      assert.equal((yield* service.list(scope)).records.length, 8);
      yield* TestClock.adjust("91 days");
      assert.deepEqual((yield* service.list(scope)).guidance, []);
    }).pipe(Effect.provide(makeLayer((request) => Effect.succeed(verdict(request.packet))))),
);

it.effect("excludes a follow-up evaluation after its cited context is rolled back", () =>
  Effect.gen(function* () {
    const seeded = yield* seed();
    const followup = RunId.make("followup-run");
    yield* seed({
      existingThread: seeded.thread,
      run: followup,
      requestedAt: DateTime.add(at, { seconds: 10 }),
    });
    const service = yield* ModelEvaluations.ModelEvaluations;
    yield* service.evaluateRun({ ...input, runId: followup });
    assert.equal((yield* service.list(scope)).records.length, 1);
    yield* persist({
      id: EventId.make("rollback-prior-context"),
      type: "run.updated",
      threadId,
      runId,
      occurredAt: at,
      payload: { ...seeded.run, status: "rolled_back" },
    });
    assert.deepEqual((yield* service.list(scope)).records, []);
  }).pipe(
    Effect.provide(
      makeLayer((request) => {
        assert.equal(request.packet.context.length, 2);
        return Effect.succeed(verdict(request.packet));
      }),
    ),
  ),
);

it.effect.each([false, true])(
  "includes cancelled context only when the run started (%s)",
  (started) =>
    Effect.gen(function* () {
      const seeded = yield* seed({ missingReply: true });
      yield* persist({
        id: EventId.make("cancelled-queued-request"),
        type: "message.updated",
        threadId,
        runId,
        occurredAt: at,
        payload: { ...seeded.messages[0]!, runId, text: "Discard this queued request." },
      });
      yield* persist({
        id: EventId.make("cancelled-queued-run"),
        type: "run.updated",
        threadId,
        runId,
        occurredAt: at,
        payload: { ...seeded.run, status: "cancelled", startedAt: started ? at : null },
      });
      const followup = RunId.make("after-cancelled-queue");
      yield* seed({
        existingThread: seeded.thread,
        run: followup,
        requestedAt: DateTime.add(at, { seconds: 10 }),
      });
      const service = yield* ModelEvaluations.ModelEvaluations;
      yield* service.evaluateRun({ ...input, runId: followup });
      assert.equal((yield* service.list(scope)).records.length, 1);
    }).pipe(
      Effect.provide(
        makeLayer((request) => {
          assert.deepEqual(
            request.packet.context,
            started ? [{ ref: "C1", kind: "user", text: "Discard this queued request." }] : [],
          );
          return Effect.succeed(verdict(request.packet));
        }),
      ),
    ),
);

it.effect.each(["default", "mixed"] as const)(
  "does not attribute ambiguous %s execution to one model",
  (kind) => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const seeded = yield* seed({
        model: kind === "default" ? { ...modelSelection, model: "default" } : modelSelection,
      });
      if (kind === "mixed")
        yield* persist({
          id: EventId.make("earlier-different-model"),
          type: "run.updated",
          threadId,
          runId,
          occurredAt: at,
          payload: {
            ...seeded.run,
            status: "running",
            modelSelection: { ...modelSelection, model: "another-model" },
          },
        });
      if (kind === "mixed")
        yield* persist({
          id: EventId.make("restore-completed-model"),
          type: "run.updated",
          threadId,
          runId,
          occurredAt: at,
          payload: seeded.run,
        });
      const service = yield* ModelEvaluations.ModelEvaluations;
      yield* service.evaluateRun(input);
      assert.deepEqual(calls, []);
      assert.equal((yield* service.list(scope)).records[0]?.status, "skipped");
      assert.deepEqual((yield* service.list(scope)).guidance, []);
    }).pipe(
      Effect.provide(
        makeLayer((request) => {
          calls.push("judge");
          return Effect.succeed(verdict(request.packet));
        }),
      ),
    );
  },
);

it.effect(
  "redacts custom catalog names and aliases without changing stored model attribution",
  () => {
    const candidate = { instanceId, model: "vendor/model-abc" };
    const published = decodeProvider({
      instanceId,
      driver: "opencode",
      displayName: "Custom harness",
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "1970-01-01T00:00:00.000Z",
      models: [
        {
          slug: candidate.model,
          name: "Nemo",
          shortName: "Nem",
          aliases: ["Captain"],
          isCustom: true,
          capabilities: null,
        },
      ],
    });
    return Effect.gen(function* () {
      const seeded = yield* seed({ model: candidate });
      yield* persist({
        id: EventId.make("alias-reply"),
        type: "message.updated",
        threadId,
        runId,
        occurredAt: at,
        payload: {
          ...seeded.messages[1]!,
          text: "Nemo / Nem / Captain via Custom harness completed the named export.",
        },
      });
      const service = yield* ModelEvaluations.ModelEvaluations;
      yield* service.evaluateRun(input);
      assert.deepEqual((yield* service.list(scope)).records[0]?.modelSelection, candidate);
    }).pipe(
      Effect.provide(
        makeLayer(
          (request) => {
            assert.notMatch(
              JSON.stringify(request.packet),
              /Nemo|Nem|Captain|Custom harness|model-abc/i,
            );
            return Effect.succeed(verdict(request.packet));
          },
          true,
          [published],
        ),
      ),
    );
  },
);

it.effect("retrieves requested model guidance before applying the group limit", () =>
  Effect.gen(function* () {
    const service = yield* ModelEvaluations.ModelEvaluations;
    for (let index = 0; index < 21; index++) {
      const thread = ThreadId.make(`limited-thread-${index}`);
      const id = RunId.make(`limited-run-${index}`);
      yield* seed({ thread, run: id, model: { instanceId, model: `model-${index}` } });
      yield* service.evaluateRun({ threadId: thread, runId: id, runOutcome: "completed" });
    }
    const report = yield* service.list(scope);
    assert.equal(report.guidance.length, 20);
    const omitted = report.records.find(
      (record) =>
        !report.guidance.some(
          (group) => group.modelSelection.model === record.modelSelection.model,
        ),
    )!;
    const selected = yield* service.guidance({ projectId, models: [omitted.modelSelection] });
    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.modelSelection.model, omitted.modelSelection.model);
  }).pipe(Effect.provide(makeLayer((request) => Effect.succeed(verdict(request.packet))))),
);

it.effect(
  "records unfinished checkpoint finalization as unavailable without judging the model",
  () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const seeded = yield* seed();
      yield* persist({
        id: EventId.make("checkpoint-not-settled"),
        type: "run.updated",
        threadId,
        runId,
        occurredAt: at,
        payload: { ...seeded.run, status: "waiting", completedAt: null },
      });
      const service = yield* ModelEvaluations.ModelEvaluations;
      yield* service.evaluateRun({ ...input, runOutcome: "failed" });
      assert.deepEqual(calls, []);
      const report = yield* service.list(scope);
      assert.equal(report.records[0]?.status, "skipped");
      assert.include(report.records[0]!.reason!, "checkpoint");
      assert.deepEqual(report.guidance, []);
    }).pipe(
      Effect.provide(
        makeLayer((request) => {
          calls.push("judge");
          return Effect.succeed(verdict(request.packet));
        }),
      ),
    );
  },
);
