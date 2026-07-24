import {
  CommandId,
  EventId,
  IsoDateTime,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type UsageFact,
  UsageFactId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionUsageRepository } from "../../persistence/Services/ProjectionUsage.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";

const BaseTestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-projection-pipeline-usage-test-" }),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const threadId = ThreadId.make("thread-usage");
const turnId = TurnId.make("turn-usage");
const projectId = ProjectId.make("project-usage");
const observedAt = IsoDateTime.make("2026-04-01T12:00:00.000Z");

function makeFact(factId: string, overrides: Partial<UsageFact> = {}): UsageFact {
  return {
    factId: UsageFactId.make(factId),
    kind: "final",
    provider: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make("claude-primary"),
    providerSessionId: "session-claude-1",
    model: "claude-fable-5",
    modelRaw: "claude-fable-5[1m]",
    reasoningEffort: "high",
    tokens: {
      inputTokens: 100,
      cachedInputTokens: 1_000,
      cacheCreationTokens: 200,
      outputTokens: 50,
      reasoningOutputTokens: 0,
    },
    costMicroUsd: 1_250_000,
    observedAt,
    ...overrides,
  };
}

it.layer(BaseTestLayer)("usage projection", (it) => {
  it.effect("projects every usage fact with exact persisted values", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "thread.usage-recorded",
        eventId: EventId.make("evt-usage-single"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: observedAt,
        commandId: CommandId.make("cmd-usage-single"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-usage-single"),
        metadata: {},
        payload: {
          threadId,
          turnId,
          projectId,
          facts: [
            makeFact("fact-final"),
            makeFact("fact-interval", {
              kind: "interval",
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId: undefined,
              providerSessionId: "session-codex-1",
              model: "gpt-5.6",
              modelRaw: "gpt-5.6",
              reasoningEffort: undefined,
              tokens: {
                inputTokens: 300,
                cachedInputTokens: 75,
                cacheCreationTokens: 0,
                outputTokens: 125,
                reasoningOutputTokens: 40,
              },
              costMicroUsd: undefined,
              observedAt: IsoDateTime.make("2026-04-01T12:00:01.000Z"),
            }),
          ],
          recordedAt: IsoDateTime.make("2026-04-01T12:00:02.000Z"),
        },
      });

      const rows = yield* sql<{
        readonly factId: string;
        readonly threadId: string;
        readonly turnId: string | null;
        readonly projectId: string | null;
        readonly provider: string;
        readonly providerInstanceId: string | null;
        readonly providerSessionId: string;
        readonly model: string;
        readonly modelRaw: string;
        readonly reasoningEffort: string | null;
        readonly kind: string;
        readonly inputTokens: number;
        readonly cachedInputTokens: number;
        readonly cacheCreationTokens: number;
        readonly outputTokens: number;
        readonly reasoningOutputTokens: number;
        readonly costMicroUsd: number | null;
        readonly stale: number;
        readonly observedAt: string;
      }>`
        SELECT
          fact_id AS "factId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          project_id AS "projectId",
          provider,
          provider_instance_id AS "providerInstanceId",
          provider_session_id AS "providerSessionId",
          model,
          model_raw AS "modelRaw",
          reasoning_effort AS "reasoningEffort",
          kind,
          input_tokens AS "inputTokens",
          cached_input_tokens AS "cachedInputTokens",
          cache_creation_tokens AS "cacheCreationTokens",
          output_tokens AS "outputTokens",
          reasoning_output_tokens AS "reasoningOutputTokens",
          cost_micro_usd AS "costMicroUsd",
          stale,
          observed_at AS "observedAt"
        FROM projection_usage_facts
        ORDER BY fact_id ASC
      `;

      assert.deepEqual(rows, [
        {
          factId: "fact-final",
          threadId: "thread-usage",
          turnId: "turn-usage",
          projectId: "project-usage",
          provider: "claudeAgent",
          providerInstanceId: "claude-primary",
          providerSessionId: "session-claude-1",
          model: "claude-fable-5",
          modelRaw: "claude-fable-5[1m]",
          reasoningEffort: "high",
          kind: "final",
          inputTokens: 100,
          cachedInputTokens: 1_000,
          cacheCreationTokens: 200,
          outputTokens: 50,
          reasoningOutputTokens: 0,
          costMicroUsd: 1_250_000,
          stale: 0,
          observedAt: "2026-04-01T12:00:00.000Z",
        },
        {
          factId: "fact-interval",
          threadId: "thread-usage",
          turnId: "turn-usage",
          projectId: "project-usage",
          provider: "codex",
          providerInstanceId: null,
          providerSessionId: "session-codex-1",
          model: "gpt-5.6",
          modelRaw: "gpt-5.6",
          reasoningEffort: null,
          kind: "interval",
          inputTokens: 300,
          cachedInputTokens: 75,
          cacheCreationTokens: 0,
          outputTokens: 125,
          reasoningOutputTokens: 40,
          costMicroUsd: null,
          stale: 0,
          observedAt: "2026-04-01T12:00:01.000Z",
        },
      ]);
    }),
  );

  it.effect("upserts repeated facts by fact id", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));
      const facts = [makeFact("fact-replay-1"), makeFact("fact-replay-2", { kind: "interval" })];

      for (const suffix of ["one", "two"] as const) {
        yield* appendAndProject({
          type: "thread.usage-recorded",
          eventId: EventId.make(`evt-usage-replay-${suffix}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: observedAt,
          commandId: CommandId.make(`cmd-usage-replay-${suffix}`),
          causationEventId: null,
          correlationId: CommandId.make(`cmd-usage-replay-${suffix}`),
          metadata: {},
          payload: {
            threadId,
            turnId,
            projectId,
            facts,
            recordedAt: observedAt,
          },
        });
      }

      const rows = yield* sql<{ readonly factId: string }>`
        SELECT fact_id AS "factId"
        FROM projection_usage_facts
        WHERE fact_id IN ('fact-replay-1', 'fact-replay-2')
        ORDER BY fact_id ASC
      `;
      assert.deepEqual(rows, [{ factId: "fact-replay-1" }, { factId: "fact-replay-2" }]);
    }),
  );

  it.effect("retains usage facts after a thread revert", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "thread.usage-recorded",
        eventId: EventId.make("evt-usage-before-revert"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: observedAt,
        commandId: CommandId.make("cmd-usage-before-revert"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-usage-before-revert"),
        metadata: {},
        payload: {
          threadId,
          turnId,
          projectId,
          facts: [makeFact("fact-retained")],
          recordedAt: observedAt,
        },
      });

      const before = yield* sql<{
        readonly factId: string;
        readonly threadId: string;
        readonly projectId: string | null;
        readonly outputTokens: number;
        readonly costMicroUsd: number | null;
      }>`
        SELECT
          fact_id AS "factId",
          thread_id AS "threadId",
          project_id AS "projectId",
          output_tokens AS "outputTokens",
          cost_micro_usd AS "costMicroUsd"
        FROM projection_usage_facts
        WHERE fact_id = 'fact-retained'
      `;

      yield* appendAndProject({
        type: "thread.reverted",
        eventId: EventId.make("evt-usage-reverted"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: IsoDateTime.make("2026-04-01T12:01:00.000Z"),
        commandId: CommandId.make("cmd-usage-reverted"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-usage-reverted"),
        metadata: {},
        payload: { threadId, turnCount: 0 },
      });

      const after = yield* sql<{
        readonly factId: string;
        readonly threadId: string;
        readonly projectId: string | null;
        readonly outputTokens: number;
        readonly costMicroUsd: number | null;
      }>`
        SELECT
          fact_id AS "factId",
          thread_id AS "threadId",
          project_id AS "projectId",
          output_tokens AS "outputTokens",
          cost_micro_usd AS "costMicroUsd"
        FROM projection_usage_facts
        WHERE fact_id = 'fact-retained'
      `;

      assert.deepEqual(after, before);
      assert.deepEqual(after, [
        {
          factId: "fact-retained",
          threadId: "thread-usage",
          projectId: "project-usage",
          outputTokens: 50,
          costMicroUsd: 1_250_000,
        },
      ]);
    }),
  );

  it.effect("redacts thread and project attribution after thread deletion", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "thread.usage-recorded",
        eventId: EventId.make("evt-usage-before-delete"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: observedAt,
        commandId: CommandId.make("cmd-usage-before-delete"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-usage-before-delete"),
        metadata: {},
        payload: {
          threadId,
          turnId,
          projectId,
          facts: [makeFact("fact-redacted-1"), makeFact("fact-redacted-2")],
          recordedAt: observedAt,
        },
      });

      yield* appendAndProject({
        type: "thread.deleted",
        eventId: EventId.make("evt-usage-deleted"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: IsoDateTime.make("2026-04-01T12:01:00.000Z"),
        commandId: CommandId.make("cmd-usage-deleted"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-usage-deleted"),
        metadata: {},
        payload: {
          threadId,
          deletedAt: IsoDateTime.make("2026-04-01T12:01:00.000Z"),
        },
      });

      const rows = yield* sql<{
        readonly factId: string;
        readonly threadId: string;
        readonly projectId: string | null;
      }>`
        SELECT
          fact_id AS "factId",
          thread_id AS "threadId",
          project_id AS "projectId"
        FROM projection_usage_facts
        WHERE fact_id IN ('fact-redacted-1', 'fact-redacted-2')
        ORDER BY fact_id ASC
      `;
      assert.deepEqual(rows, [
        { factId: "fact-redacted-1", threadId: "deleted", projectId: null },
        { factId: "fact-redacted-2", threadId: "deleted", projectId: null },
      ]);
    }),
  );

  it.effect("persists the stale flag", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "thread.usage-recorded",
        eventId: EventId.make("evt-usage-stale"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: observedAt,
        commandId: CommandId.make("cmd-usage-stale"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-usage-stale"),
        metadata: {},
        payload: {
          threadId,
          turnId,
          projectId: null,
          facts: [makeFact("fact-stale", { stale: true })],
          recordedAt: observedAt,
        },
      });

      const rows = yield* sql<{ readonly factId: string; readonly stale: number }>`
        SELECT fact_id AS "factId", stale
        FROM projection_usage_facts
        WHERE fact_id = 'fact-stale'
      `;
      assert.deepEqual(rows, [{ factId: "fact-stale", stale: 1 }]);
    }),
  );

  it.effect("sums final and interval facts by session and model", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const usageRepository = yield* ProjectionUsageRepository;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "thread.usage-recorded",
        eventId: EventId.make("evt-usage-sums"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: observedAt,
        commandId: CommandId.make("cmd-usage-sums"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-usage-sums"),
        metadata: {},
        payload: {
          threadId,
          turnId,
          projectId,
          facts: [
            makeFact("fact-sum-fable-final", {
              providerSessionId: "session-target",
              tokens: {
                inputTokens: 100,
                cachedInputTokens: 10,
                cacheCreationTokens: 5,
                outputTokens: 20,
                reasoningOutputTokens: 2,
              },
              costMicroUsd: 1_000,
            }),
            makeFact("fact-sum-fable-interval", {
              kind: "interval",
              providerSessionId: "session-target",
              tokens: {
                inputTokens: 50,
                cachedInputTokens: 5,
                cacheCreationTokens: 3,
                outputTokens: 10,
                reasoningOutputTokens: 1,
              },
              costMicroUsd: 500,
            }),
            makeFact("fact-sum-opus", {
              providerSessionId: "session-target",
              model: "claude-opus-4-8",
              modelRaw: "claude-opus-4-8",
              tokens: {
                inputTokens: 200,
                cachedInputTokens: 20,
                cacheCreationTokens: 8,
                outputTokens: 40,
                reasoningOutputTokens: 4,
              },
              costMicroUsd: 2_000,
            }),
            makeFact("fact-sum-turn-total", {
              kind: "turn-total",
              providerSessionId: "session-target",
              tokens: {
                inputTokens: 9_999,
                cachedInputTokens: 9_999,
                cacheCreationTokens: 9_999,
                outputTokens: 9_999,
                reasoningOutputTokens: 9_999,
              },
              costMicroUsd: 9_999,
            }),
            makeFact("fact-sum-other-session", {
              providerSessionId: "session-other",
              tokens: {
                inputTokens: 8_888,
                cachedInputTokens: 8_888,
                cacheCreationTokens: 8_888,
                outputTokens: 8_888,
                reasoningOutputTokens: 8_888,
              },
              costMicroUsd: 8_888,
            }),
          ],
          recordedAt: observedAt,
        },
      });

      const sums = yield* usageRepository.sumBySessionModel({
        providerSessionId: "session-target",
      });
      assert.deepEqual(
        [...sums].toSorted((left, right) => left.model.localeCompare(right.model)),
        [
          {
            model: "claude-fable-5",
            inputTokens: 150,
            cachedInputTokens: 15,
            cacheCreationTokens: 8,
            outputTokens: 30,
            reasoningOutputTokens: 3,
            costMicroUsd: 1_500,
          },
          {
            model: "claude-opus-4-8",
            inputTokens: 200,
            cachedInputTokens: 20,
            cacheCreationTokens: 8,
            outputTokens: 40,
            reasoningOutputTokens: 4,
            costMicroUsd: 2_000,
          },
        ],
      );
    }),
  );
});
