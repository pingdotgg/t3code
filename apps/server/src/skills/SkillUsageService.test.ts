import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2ProviderTurnJson,
  OrchestrationV2RunJson,
  OrchestrationV2TurnItemJson,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  SkillTurnResolution,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as Usage from "../usage/UsageService.ts";
import * as SkillUsage from "./SkillUsageService.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const testLayer = SkillUsage.layer.pipe(Layer.provideMerge(database));
const layer = it.layer(testLayer);
const noEvidenceTableLayer = SkillUsage.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const pricedLayer = (
  costSource: "modelPriced" | "providerReported",
  expectedReportedCost: number | null,
) =>
  SkillUsage.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeSqliteClient.layer({ filename: ":memory:" }),
        Layer.succeed(
          Usage.UsageService,
          Usage.UsageService.of({
            readSummary: () => Effect.die("unused"),
            priceRecord: (record) => {
              assert.equal(record.reportedCostUsd, expectedReportedCost);
              return Effect.succeed({
                costUsd: 0.0123,
                costSource,
                categoryCostUsd: null,
                speedPremiumUsd: 0,
              });
            },
            refreshRates: Effect.die("unused"),
          }),
        ),
      ),
    ),
  );

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("thread:skill-usage");
const providerThreadId = ProviderThreadId.make("provider-thread:skill-usage");
const rootNodeId = NodeId.make("node:skill-usage");
const startedAt = DateTime.makeUnsafe("2026-10-29T10:00:05.000Z");
const requestedAt = DateTime.makeUnsafe("2026-10-29T10:00:00.000Z");
const completedAt = DateTime.makeUnsafe("2026-10-29T10:01:05.000Z");
const updatedAt = DateTime.makeUnsafe("2026-10-29T10:00:30.000Z");

const encodeRun = Schema.encodeUnknownSync(Schema.fromJsonString(OrchestrationV2RunJson));
const encodeMessage = Schema.encodeUnknownSync(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);
const encodeProviderTurn = Schema.encodeUnknownSync(
  Schema.fromJsonString(OrchestrationV2ProviderTurnJson),
);
const encodeTurnItem = Schema.encodeUnknownSync(Schema.fromJsonString(OrchestrationV2TurnItemJson));

const resolution = SkillTurnResolution.make({
  entries: [
    {
      skillName: "review",
      ruleId: "rule:review",
      revision: 1,
      mode: "variant",
      contentHash: "variant-hash",
      variantPath: "/state/skill-variants/variant-hash/SKILL.md",
      origin: "rule",
    },
  ],
  hash: "resolution-hash",
});

const reset = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM skill_activated_provider_threads`;
  yield* sql`DELETE FROM skill_turn_evidence`;
  yield* sql`DELETE FROM skill_turns`;
  yield* sql`DELETE FROM orchestration_v2_projection_turn_items`;
  yield* sql`DELETE FROM orchestration_v2_projection_provider_turns`;
  yield* sql`DELETE FROM orchestration_v2_projection_run_attempts`;
  yield* sql`DELETE FROM orchestration_v2_projection_messages`;
  yield* sql`DELETE FROM orchestration_v2_projection_runs`;
});

const makeRun = (input: {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly ordinal?: number;
  readonly status?: OrchestrationV2Run["status"];
}): OrchestrationV2Run => ({
  id: input.runId,
  threadId,
  ordinal: input.ordinal ?? 1,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "gpt-5.6-sol" },
  providerThreadId,
  userMessageId: input.messageId,
  rootNodeId,
  activeAttemptId: null,
  status: input.status ?? "completed",
  queuePosition: null,
  requestedAt,
  startedAt: input.status === "queued" ? null : startedAt,
  completedAt: input.status === "queued" || input.status === "running" ? null : completedAt,
  checkpointId: null,
  contextHandoffId: null,
});

const makeMessage = (input: {
  readonly messageId: MessageId;
  readonly runId: RunId;
  readonly text: string;
  readonly createdAt?: DateTime.Utc;
}): OrchestrationV2ConversationMessage => ({
  id: input.messageId,
  threadId,
  runId: input.runId,
  nodeId: rootNodeId,
  role: "user",
  text: input.text,
  attachments: [],
  streaming: false,
  createdBy: "user",
  creationSource: "web",
  createdAt: input.createdAt ?? requestedAt,
  updatedAt: input.createdAt ?? requestedAt,
});

const insertRun = (run: OrchestrationV2Run) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id,
        thread_id,
        ordinal,
        provider,
        provider_thread_id,
        status,
        requested_at,
        completed_at,
        payload_json
      ) VALUES (
        ${run.id},
        ${run.threadId},
        ${run.ordinal},
        ${run.providerInstanceId},
        ${run.providerThreadId},
        ${run.status},
        ${DateTime.formatIso(run.requestedAt)},
        ${run.completedAt === null ? null : DateTime.formatIso(run.completedAt)},
        ${encodeRun(run)}
      )
    `;
  });

const insertMessage = (message: OrchestrationV2ConversationMessage) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (
        message_id,
        thread_id,
        run_id,
        node_id,
        role,
        streaming,
        created_at,
        updated_at,
        payload_json
      ) VALUES (
        ${message.id},
        ${message.threadId},
        ${message.runId},
        ${message.nodeId},
        ${message.role},
        ${message.streaming ? 1 : 0},
        ${DateTime.formatIso(message.createdAt)},
        ${DateTime.formatIso(message.updatedAt)},
        ${encodeMessage(message)}
      )
    `;
  });

const insertTurnItem = (item: OrchestrationV2TurnItem) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id,
        thread_id,
        run_id,
        node_id,
        provider_thread_id,
        provider_turn_id,
        parent_item_id,
        ordinal,
        type,
        status,
        updated_at,
        payload_json
      ) VALUES (
        ${item.id},
        ${item.threadId},
        ${item.runId},
        ${item.nodeId},
        ${item.providerThreadId},
        ${item.providerTurnId},
        ${item.parentItemId},
        ${item.ordinal},
        ${item.type},
        ${item.status},
        ${DateTime.formatIso(item.updatedAt)},
        ${encodeTurnItem(item)}
      )
    `;
  });

const insertProviderTurn = (
  runId: RunId,
  input: {
    readonly suffix?: string;
    readonly attemptOrdinal?: number;
    readonly turnOrdinal?: number;
    readonly inputTokens?: number;
    readonly reportedCostUsd?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const suffix = input.suffix === undefined ? "" : `:${input.suffix}`;
    const attemptId = RunAttemptId.make(`attempt:${runId}${suffix}`);
    const providerTurn: OrchestrationV2ProviderTurn = {
      id: ProviderTurnId.make(`provider-turn:${runId}${suffix}`),
      providerThreadId,
      nodeId: rootNodeId,
      runAttemptId: attemptId,
      nativeTurnRef: null,
      ordinal: input.turnOrdinal ?? 1,
      status: "completed",
      startedAt,
      completedAt,
      turnTokenUsage: {
        usageScope: "main_agent",
        usageStatus: "complete",
        inputTokens: input.inputTokens ?? 120,
        cachedInputTokens: 20,
        outputTokens: 45,
        reasoningTokens: 15,
        ...(input.reportedCostUsd === undefined ? {} : { reportedCostUsd: input.reportedCostUsd }),
        hasSubagents: false,
      },
    };
    yield* sql`
      INSERT INTO orchestration_v2_projection_run_attempts (
        attempt_id,
        thread_id,
        run_id,
        attempt_ordinal,
        root_node_id,
        provider,
        provider_thread_id,
        provider_turn_id,
        status,
        payload_json
      ) VALUES (
        ${attemptId},
        ${threadId},
        ${runId},
        ${input.attemptOrdinal ?? 1},
        ${rootNodeId},
        ${instanceId},
        ${providerThreadId},
        ${providerTurn.id},
        'completed',
        '{}'
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_turns (
        provider_turn_id,
        thread_id,
        provider_thread_id,
        node_id,
        run_attempt_id,
        ordinal,
        status,
        started_at,
        completed_at,
        payload_json
      ) VALUES (
        ${providerTurn.id},
        ${threadId},
        ${providerThreadId},
        ${rootNodeId},
        ${attemptId},
        ${providerTurn.ordinal},
        'completed',
        ${DateTime.formatIso(startedAt)},
        ${DateTime.formatIso(completedAt)},
        ${encodeProviderTurn(providerTurn)}
      )
    `;
  });

const itemBase = (runId: RunId, ordinal: number) => ({
  id: TurnItemId.make(`item:${runId}:${ordinal}`),
  threadId,
  runId,
  nodeId: rootNodeId,
  providerThreadId,
  providerTurnId: ProviderTurnId.make(`provider-turn:${runId}`),
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: updatedAt,
  completedAt: updatedAt,
  updatedAt,
});

const recordInput = (runId: RunId) => ({
  runId,
  threadId,
  instanceId,
  driver,
  model: "gpt-5.6-sol",
  delivery: "developer-context" as const,
  resolution,
  available: [{ name: "review", path: "/home/user/.claude/skills/review/SKILL.md" }],
});

layer("SkillUsageService", (it) => {
  it.effect("records turn starts idempotently", () =>
    Effect.gen(function* () {
      yield* reset;
      const service = yield* SkillUsage.SkillUsageService;
      const sql = yield* SqlClient.SqlClient;
      const runId = RunId.make("run:idempotent");

      yield* service.recordTurnStart({
        ...recordInput(runId),
        available: [
          { name: "Review", path: "/home/user/.claude/skills/review/SKILL.md" },
          { name: " review ", path: " /home/user/.claude/skills/review/SKILL.md " },
          { name: "REVIEW", path: "/other/review/SKILL.md" },
        ],
      });
      yield* service.recordTurnStart({
        ...recordInput(runId),
        model: "changed-model",
        available: [{ name: "other", path: "/skills/other/SKILL.md" }],
      });

      const rows = yield* sql<{
        readonly count: number;
        readonly model: string;
        readonly available_json: string;
      }>`
        SELECT COUNT(*) AS count, model, available_json
        FROM skill_turns
        WHERE run_id = ${runId}
      `;
      assert.equal(rows[0]?.count, 1);
      assert.equal(rows[0]?.model, "gpt-5.6-sol");
      assert.equal(
        rows[0]?.available_json,
        '[{"name":"Review","path":"/home/user/.claude/skills/review/SKILL.md"}]',
      );
    }),
  );

  it.effect("finalizes outcomes and captures every evidence source", () =>
    Effect.gen(function* () {
      yield* reset;
      const service = yield* SkillUsage.SkillUsageService;
      const sql = yield* SqlClient.SqlClient;
      const runId = RunId.make("run:finalized");
      const messageId = MessageId.make("message:finalized");
      const run = makeRun({ runId, messageId });
      yield* insertRun(run);
      yield* insertMessage(makeMessage({ messageId, runId, text: "Use $review here." }));
      yield* insertProviderTurn(runId, {
        suffix: "older-attempt",
        attemptOrdinal: 1,
        turnOrdinal: 9,
        inputTokens: 999,
      });
      yield* insertProviderTurn(runId, { attemptOrdinal: 2 });
      yield* service.recordTurnStart(recordInput(runId));

      const items: OrchestrationV2TurnItem[] = [
        {
          ...itemBase(runId, 1),
          type: "command_execution",
          input: "cat /state/skill-variants/variant-hash/SKILL.md",
          exitCode: 0,
        },
        {
          ...itemBase(runId, 2),
          type: "command_execution",
          input: "cat /home/user/.claude/skills/review/SKILL.md",
          exitCode: 0,
        },
        {
          ...itemBase(runId, 3),
          type: "dynamic_tool",
          toolName: "Skill",
          input: { skill: "review" },
        },
        {
          ...itemBase(runId, 4),
          type: "command_execution",
          input: "node /home/user/.claude/skills/review/scripts/check.mjs",
          exitCode: 0,
        },
        {
          ...itemBase(runId, 5),
          type: "assistant_message",
          messageId: MessageId.make("message:assistant"),
          text: "I applied the review guidance.",
          streaming: false,
        },
        {
          ...itemBase(runId, 6),
          type: "command_execution",
          input: "false",
          exitCode: 7,
        },
        {
          ...itemBase(runId, 7),
          type: "error",
          failure: {
            class: "provider_error",
            message: "provider failed",
            code: null,
            retryable: false,
          },
        },
      ];
      for (const item of items) yield* insertTurnItem(item);

      // Not finalized yet, so no marker: the latest terminal run is still derived in memory.
      assert.deepEqual(
        (yield* service.activatedOnProviderThread(providerThreadId)).map(
          (context) => context.skillName,
        ),
        ["review"],
      );
      const pendingRows = yield* sql<{
        readonly outcome_json: string | null;
        readonly finalized_at: string | null;
        readonly evidence_count: number;
      }>`
        SELECT
          turn.outcome_json,
          turn.finalized_at,
          (SELECT COUNT(*) FROM skill_turn_evidence WHERE run_id = turn.run_id) AS evidence_count
        FROM skill_turns AS turn
        WHERE turn.run_id = ${runId}
      `;
      assert.isNull(pendingRows[0]?.outcome_json ?? null);
      assert.isNull(pendingRows[0]?.finalized_at ?? null);
      assert.equal(pendingRows[0]?.evidence_count, 0);
      assert.isTrue(yield* service.finalizeRun(runId));
      assert.equal(yield* service.finalizePending(10), 0);
      const markerRows = yield* sql<{ readonly provider_thread_id: string }>`
        SELECT provider_thread_id
        FROM skill_activated_provider_threads
        WHERE provider_thread_id = ${providerThreadId}
      `;
      assert.deepEqual(markerRows, [{ provider_thread_id: providerThreadId }]);
      assert.deepEqual(yield* service.activatedOnProviderThread(providerThreadId), [
        {
          skillName: "review",
          mode: "variant",
          contentHash: "variant-hash",
          variantPath: "/state/skill-variants/variant-hash/SKILL.md",
          skillPath: "/home/user/.claude/skills/review/SKILL.md",
        },
      ]);
      const records = yield* service.listTurns({ limit: 10 });
      assert.equal(records.length, 1);
      const record = records[0];
      assert.isDefined(record);
      assert.deepEqual(record.outcome, {
        status: "completed",
        durationMs: 60_000,
        toolCalls: 5,
        toolFailures: 1,
        errors: 1,
        tokens: {
          input: 120,
          cachedInput: 20,
          cacheCreation: null,
          output: 45,
          reasoning: 15,
        },
        costUsd: null,
        costSource: "unavailable",
        reverted: false,
        followupCorrection: null,
      });
      assert.deepEqual(record.evidence.map((entry) => `${entry.kind}/${entry.source}`).sort(), [
        "activated/native_skill_tool",
        "activated/skill_file_read",
        "activated/variant_file_read",
        "applied/skill_resource",
        "claimed/assistant_mention",
        "requested/user_mention",
      ]);
    }),
  );

  it.effect("matches native Skill input by exact logical name", () =>
    Effect.gen(function* () {
      yield* reset;
      const service = yield* SkillUsage.SkillUsageService;
      const cases = [
        { nativeSkill: "review", expectedSkills: ["review"] },
        { nativeSkill: "code-review", expectedSkills: ["code-review"] },
        { nativeSkill: "t3-variants:review-t3-variant", expectedSkills: ["review"] },
        { nativeSkill: "plugin:review", expectedSkills: ["review"] },
        { nativeSkill: "other:review", expectedSkills: [] },
        { nativeSkill: "plugin:other:review", expectedSkills: [] },
      ] as const;

      for (const [index, testCase] of cases.entries()) {
        const runId = RunId.make(`run:native-skill-name:${index}`);
        const messageId = MessageId.make(`message:native-skill-name:${index}`);
        yield* insertRun(makeRun({ runId, messageId, ordinal: index + 1 }));
        yield* insertMessage(makeMessage({ messageId, runId, text: "Inspect this change." }));
        yield* insertProviderTurn(runId, { turnOrdinal: index + 1 });
        yield* service.recordTurnStart({
          ...recordInput(runId),
          available: [
            { name: "review", path: "/skills/review/SKILL.md" },
            { name: "code-review", path: "/skills/code-review/SKILL.md" },
          ],
        });
        yield* insertTurnItem({
          ...itemBase(runId, 1),
          type: "dynamic_tool",
          toolName: "Skill",
          input: { skill: testCase.nativeSkill },
        });
        assert.isTrue(yield* service.finalizeRun(runId));
      }

      const records = yield* service.listTurns({ limit: 10 });
      for (const [index, testCase] of cases.entries()) {
        const record = records.find(
          (candidate) => candidate.runId === `run:native-skill-name:${index}`,
        );
        assert.deepEqual(
          record?.evidence
            .filter((entry) => entry.source === "native_skill_tool")
            .map((entry) => entry.skillName),
          [...testCase.expectedSkills],
        );
      }
    }),
  );

  it.effect("does not count a same-named skill file outside the provider catalog", () =>
    Effect.gen(function* () {
      yield* reset;
      const service = yield* SkillUsage.SkillUsageService;
      const runId = RunId.make("run:non-catalog-skill-path");
      const messageId = MessageId.make("message:non-catalog-skill-path");
      yield* insertRun(makeRun({ runId, messageId }));
      yield* insertMessage(makeMessage({ messageId, runId, text: "Inspect this change." }));
      yield* insertProviderTurn(runId);
      yield* service.recordTurnStart(recordInput(runId));
      yield* insertTurnItem({
        ...itemBase(runId, 1),
        type: "command_execution",
        input: "cat /other/provider/skills/review/SKILL.md",
        exitCode: 0,
      });

      assert.deepEqual(yield* service.activatedOnProviderThread(providerThreadId), []);
      const records = yield* service.listTurns({ limit: 10 });
      assert.deepEqual(
        records[0]?.evidence.filter(
          (entry) => entry.source === "skill_file_read" || entry.source === "skill_resource",
        ),
        [],
      );
    }),
  );

  it.effect("computes rolled-back and follow-up correction values live", () =>
    Effect.gen(function* () {
      yield* reset;
      const service = yield* SkillUsage.SkillUsageService;
      const runId = RunId.make("run:rolled-back");
      const messageId = MessageId.make("message:rolled-back");
      yield* insertRun(makeRun({ runId, messageId, status: "rolled_back" }));
      yield* insertMessage(makeMessage({ messageId, runId, text: "Use review." }));
      yield* service.recordTurnStart(recordInput(runId));
      assert.equal(yield* service.finalizePending(10), 1);

      const nextRunId = RunId.make("run:correction");
      const nextMessageId = MessageId.make("message:correction");
      yield* insertRun(
        makeRun({ runId: nextRunId, messageId: nextMessageId, ordinal: 2, status: "queued" }),
      );
      yield* insertMessage(
        makeMessage({
          messageId: nextMessageId,
          runId: nextRunId,
          text: "Actually, no — undo that.",
          createdAt: DateTime.makeUnsafe("2026-10-29T10:02:00.000Z"),
        }),
      );

      const records = yield* service.listTurns({ skillName: "review", limit: 10 });
      const outcome = records.find((record) => record.runId === runId)?.outcome;
      if (outcome === null || outcome === undefined) assert.fail("expected finalized outcome");
      assert.isTrue(outcome.reverted);
      assert.isTrue(outcome.followupCorrection);
    }),
  );

  it.effect("leaves non-terminal rows pending", () =>
    Effect.gen(function* () {
      yield* reset;
      const service = yield* SkillUsage.SkillUsageService;
      const sql = yield* SqlClient.SqlClient;
      const runId = RunId.make("run:running");
      const messageId = MessageId.make("message:running");
      yield* insertRun(makeRun({ runId, messageId, status: "running" }));
      yield* insertMessage(makeMessage({ messageId, runId, text: "/review" }));
      yield* service.recordTurnStart(recordInput(runId));

      assert.equal(yield* service.finalizePending(10), 0);
      const rows = yield* sql<{
        readonly outcome_json: string | null;
        readonly finalized_at: string | null;
      }>`
        SELECT outcome_json, finalized_at
        FROM skill_turns
        WHERE run_id = ${runId}
      `;
      assert.isNull(rows[0]?.outcome_json ?? null);
      assert.isNull(rows[0]?.finalized_at ?? null);
      const records = yield* service.listTurns({ limit: 10 });
      assert.isNull(records[0]?.outcome ?? null);
    }),
  );
});

it.effect("returns before evidence queries when a provider thread has no marker", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const service = yield* SkillUsage.SkillUsageService;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TABLE skill_turn_evidence`;

    assert.deepEqual(
      yield* service.activatedOnProviderThread(
        ProviderThreadId.make("provider-thread:without-activation"),
      ),
      [],
    );
  }).pipe(Effect.provide(noEvidenceTableLayer)),
);

for (const [pricingSource, expectedSource] of [
  ["modelPriced", "model-priced"],
  ["providerReported", "provider-reported"],
] as const) {
  it.layer(pricedLayer(pricingSource, pricingSource === "providerReported" ? 0.0123 : null))(
    `SkillUsageService ${expectedSource} cost`,
    (it) => {
      it.effect("stores the priced turn outcome", () =>
        Effect.gen(function* () {
          yield* reset;
          const service = yield* SkillUsage.SkillUsageService;
          const runId = RunId.make(`run:${pricingSource}`);
          const messageId = MessageId.make(`message:${pricingSource}`);
          yield* insertRun(makeRun({ runId, messageId }));
          yield* insertMessage(makeMessage({ messageId, runId, text: "Inspect this change." }));
          yield* insertProviderTurn(
            runId,
            pricingSource === "providerReported" ? { reportedCostUsd: 0.0123 } : {},
          );
          yield* service.recordTurnStart(recordInput(runId));

          assert.isTrue(yield* service.finalizeRun(runId));
          const records = yield* service.listTurns({ limit: 1 });
          assert.equal(records[0]?.outcome?.costUsd, 0.0123);
          assert.equal(records[0]?.outcome?.costSource, expectedSource);
        }),
      );
    },
  );
}
