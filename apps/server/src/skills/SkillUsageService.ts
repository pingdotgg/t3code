import {
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2ProviderTurnJson,
  OrchestrationV2RunJson,
  OrchestrationV2TurnItemJson,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  SkillTurnEvidence,
  SkillTurnOutcome,
  SkillTurnResolution,
  type SkillVariantDelivery,
  ThreadId,
} from "@t3tools/contracts";
import { matchInlineSkills } from "@t3tools/shared/inlineSkills";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Usage from "../usage/UsageService.ts";
import type { ActivatedSkillContext } from "./skillContextContamination.ts";
import { matchesNativeSkillName } from "./nativeSkillName.ts";
import {
  observationalSummary,
  type ObservationalGroupSummary,
  type ObservationalMode,
  type ObservationalTurn,
} from "./skillEvalStats.ts";

const FINALIZE_READ_LIMIT = 100;
const MAX_PENDING_PROVIDER_THREAD_TURNS = 5;
const MAX_TURN_ITEMS_PER_RUN = 2_000;
const FOLLOWUP_CORRECTION =
  /^\s*(no\b|nope|that'?s (wrong|not)|wrong|undo|revert|don'?t|stop|actually,? (no|don'?t)|instead\b)/i;

export interface AvailableSkillCatalogEntry {
  readonly name: string;
  readonly path: string;
}

export interface SkillTurnStartInput {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly delivery: SkillVariantDelivery;
  readonly resolution: SkillTurnResolution;
  readonly available: ReadonlyArray<AvailableSkillCatalogEntry>;
}

export interface SkillTurnRecord {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly delivery: SkillVariantDelivery;
  readonly resolution: SkillTurnResolution;
  readonly available: ReadonlyArray<AvailableSkillCatalogEntry>;
  readonly evalTrialId: string | null;
  readonly createdAt: string;
  readonly outcome: SkillTurnOutcome | null;
  readonly finalizedAt: string | null;
  readonly evidence: ReadonlyArray<SkillTurnEvidence>;
}

export interface SkillTurnListInput {
  readonly skillName?: string;
  readonly driver?: ProviderDriverKind;
  readonly model?: string;
  readonly limit: number;
}

interface SkillTurnRow {
  readonly run_id: string;
  readonly thread_id: string;
  readonly instance_id: string;
  readonly driver: string;
  readonly model: string;
  readonly delivery: SkillVariantDelivery;
  readonly resolution_json: string;
  readonly available_json: string;
  readonly eval_trial_id: string | null;
  readonly created_at: string;
  readonly outcome_json: string | null;
  readonly finalized_at: string | null;
  readonly run_status: string | null;
}

interface PendingTurnRow extends SkillTurnRow {
  readonly run_payload_json: string;
}

interface EvidenceRow {
  readonly run_id: string;
  readonly skill_name: string;
  readonly kind: SkillTurnEvidence["kind"];
  readonly source: SkillTurnEvidence["source"];
  readonly turn_item_id: string | null;
  readonly observed_at: string;
}

interface ActivatedContextRow {
  readonly resolution_json: string;
  readonly available_json: string;
  readonly skill_name: string;
}

interface ActivatedProviderThreadRow {
  readonly provider_thread_id: string;
}

interface PayloadRow {
  readonly payload_json: string;
}

interface TurnItemRow extends PayloadRow {
  readonly turn_item_id: string;
  readonly updated_at: string;
}

interface EvalTrialRow {
  readonly trial_id: string;
}

const AvailableSkillCatalogEntrySchema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
});
const decodeResolution = Schema.decodeUnknownEffect(Schema.fromJsonString(SkillTurnResolution));
const encodeResolution = Schema.encodeUnknownSync(Schema.fromJsonString(SkillTurnResolution));
const decodeAvailableJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Union([Schema.String, AvailableSkillCatalogEntrySchema])),
  ),
);
const decodeAvailable = (json: string) =>
  decodeAvailableJson(json).pipe(
    Effect.map((entries) =>
      entries.map((entry) => (typeof entry === "string" ? { name: entry, path: "" } : entry)),
    ),
  );
const encodeAvailable = Schema.encodeUnknownSync(
  Schema.fromJsonString(Schema.Array(AvailableSkillCatalogEntrySchema)),
);
const decodeOutcome = Schema.decodeUnknownEffect(Schema.fromJsonString(SkillTurnOutcome));
const encodeOutcome = Schema.encodeUnknownSync(Schema.fromJsonString(SkillTurnOutcome));
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2RunJson));
const decodeTurnItem = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJson),
);
const decodeProviderTurn = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderTurnJson),
);
const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJson),
);
const decodeEvidence = Schema.decodeUnknownEffect(SkillTurnEvidence);

export class SkillUsagePersistenceError extends Schema.TaggedError<SkillUsagePersistenceError>()(
  "SkillUsagePersistenceError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation}.`;
  }
}

const persistenceError = (operation: string, cause: unknown) =>
  new SkillUsagePersistenceError({ operation, cause });

const normalizedAvailableSkills = (
  entries: ReadonlyArray<AvailableSkillCatalogEntry>,
): AvailableSkillCatalogEntry[] => {
  const byName = new Map<string, AvailableSkillCatalogEntry>();
  for (const entry of entries) {
    const name = entry.name.trim();
    const skillPath = entry.path.trim();
    if (name.length === 0 || skillPath.length === 0) continue;
    const normalizedName = name.toLowerCase();
    if (!byName.has(normalizedName)) byName.set(normalizedName, { name, path: skillPath });
  }
  return [...byName.values()].sort((left, right) =>
    left.name === right.name
      ? left.path < right.path
        ? -1
        : left.path > right.path
          ? 1
          : 0
      : left.name < right.name
        ? -1
        : 1,
  );
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const mentionsSlashSkill = (text: string, skillName: string): boolean =>
  new RegExp(`(^|\\s)/${escapeRegExp(skillName)}(?=\\s|$)`, "iu").test(text);

const mentionsSkill = (text: string, skillName: string): boolean =>
  text.toLowerCase().includes(skillName.toLowerCase());

const pathPayload = (payload: string): string =>
  payload.toLowerCase().replaceAll("\\\\", "/").replaceAll("\\", "/");

const skillDirectory = (skillPath: string): string => {
  const normalized = pathPayload(skillPath);
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "" : normalized.slice(0, separator + 1);
};

const isToolItem = (type: string): boolean =>
  type === "command_execution" ||
  type === "dynamic_tool" ||
  type === "file_change" ||
  type === "web_search";

const isToolFailure = (item: OrchestrationV2TurnItemJson): boolean =>
  isToolItem(item.type) &&
  (item.status === "failed" ||
    (item.type === "command_execution" &&
      (item.outputIndicatesFailure === true || (item.exitCode ?? 0) !== 0)));

const tokenUsage = (turn: OrchestrationV2ProviderTurnJson | null): SkillTurnOutcome["tokens"] => {
  if (turn === null) return null;
  if (turn.turnTokenUsage !== undefined) {
    const usage = turn.turnTokenUsage;
    const tokens = {
      input: usage.inputTokens ?? null,
      cachedInput: usage.cachedInputTokens ?? null,
      cacheCreation: usage.cacheCreationTokens ?? null,
      output: usage.outputTokens ?? null,
      reasoning: usage.reasoningTokens ?? null,
    };
    return Object.values(tokens).every((value) => value === null) ? null : tokens;
  }
  if (turn.tokenUsage === undefined) return null;
  const usage = turn.tokenUsage;
  const tokens = {
    input: usage.inputTokens ?? null,
    cachedInput: usage.cachedInputTokens ?? null,
    cacheCreation: null,
    output: usage.outputTokens ?? null,
    reasoning: usage.reasoningOutputTokens ?? null,
  };
  return Object.values(tokens).every((value) => value === null) ? null : tokens;
};

const providerReportedCost = (turn: OrchestrationV2ProviderTurnJson | null): number | null =>
  turn?.turnTokenUsage?.reportedCostUsd ?? null;

const observationalTokenCount = (outcome: SkillTurnOutcome): number | null => {
  if (outcome.tokens === null) return null;
  const input = outcome.tokens.input;
  const output = outcome.tokens.output;
  return input === null && output === null ? null : (input ?? 0) + (output ?? 0);
};

const evidenceFromRow = (row: EvidenceRow) =>
  decodeEvidence({
    runId: row.run_id,
    skillName: row.skill_name,
    kind: row.kind,
    source: row.source,
    turnItemId: row.turn_item_id,
    observedAt: row.observed_at,
  });

export class SkillUsageService extends Context.Service<
  SkillUsageService,
  {
    readonly recordTurnStart: (
      input: SkillTurnStartInput,
    ) => Effect.Effect<void, SkillUsagePersistenceError>;
    readonly finalizeRun: (runId: RunId) => Effect.Effect<boolean, SkillUsagePersistenceError>;
    readonly finalizePending: (limit: number) => Effect.Effect<number, SkillUsagePersistenceError>;
    readonly listTurns: (
      input: SkillTurnListInput,
    ) => Effect.Effect<ReadonlyArray<SkillTurnRecord>, SkillUsagePersistenceError>;
    readonly activatedOnProviderThread: (
      providerThreadId: ProviderThreadId,
    ) => Effect.Effect<ReadonlyArray<ActivatedSkillContext>, SkillUsagePersistenceError>;
    readonly observational: (input: {
      readonly skillName: string;
    }) => Effect.Effect<ReadonlyArray<ObservationalGroupSummary>, SkillUsagePersistenceError>;
  }
>()("t3/skills/SkillUsageService") {}

export const layer = Layer.effect(
  SkillUsageService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const usage = yield* Effect.serviceOption(Usage.UsageService);

    const nextUserMessage = Effect.fn("SkillUsageService.nextUserMessage")(function* (
      threadId: ThreadId,
      runOrdinal: number,
    ) {
      const rows = yield* sql<PayloadRow>`
        SELECT message.payload_json
        FROM orchestration_v2_projection_runs AS run
        JOIN orchestration_v2_projection_messages AS message
          ON message.message_id = json_extract(run.payload_json, '$.userMessageId')
        WHERE run.thread_id = ${threadId}
          AND run.ordinal > ${runOrdinal}
          AND message.role = 'user'
        ORDER BY run.ordinal ASC
        LIMIT 1
      `;
      return rows[0] === undefined ? null : yield* decodeMessage(rows[0].payload_json);
    });

    const insertEvidence = Effect.fn("SkillUsageService.insertEvidence")(function* (
      evidence: SkillTurnEvidence,
    ) {
      yield* sql`
        INSERT OR IGNORE INTO skill_turn_evidence (
          run_id,
          skill_name,
          kind,
          source,
          turn_item_id,
          observed_at
        ) VALUES (
          ${evidence.runId},
          ${evidence.skillName},
          ${evidence.kind},
          ${evidence.source},
          ${evidence.turnItemId},
          ${evidence.observedAt}
        )
      `;
    });

    const priceTurn = Effect.fn("SkillUsageService.priceTurn")(function* (
      model: string,
      tokens: SkillTurnOutcome["tokens"],
      reportedCostUsd: number | null,
    ) {
      if (tokens === null && reportedCostUsd === null) {
        return { costUsd: null, costSource: "unavailable" as const };
      }
      if (Option.isNone(usage)) {
        return reportedCostUsd === null
          ? { costUsd: null, costSource: "unavailable" as const }
          : { costUsd: reportedCostUsd, costSource: "provider-reported" as const };
      }
      const cachedInput = tokens?.cachedInput ?? 0;
      const cacheCreation = tokens?.cacheCreation ?? 0;
      const priced = yield* usage.value
        .priceRecord({
          model,
          totals: {
            uncachedInputTokens: Math.max(0, (tokens?.input ?? 0) - cachedInput - cacheCreation),
            cachedInputTokens: cachedInput,
            cacheCreationTokens: cacheCreation,
            outputTokens: tokens?.output ?? 0,
            reasoningTokens: tokens?.reasoning ?? 0,
          },
          speed: "standard",
          reportedCostUsd,
        })
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (priced === null || priced.costSource === "unpriced") {
        return reportedCostUsd === null
          ? { costUsd: null, costSource: "unavailable" as const }
          : { costUsd: reportedCostUsd, costSource: "provider-reported" as const };
      }
      return {
        costUsd: priced.costUsd,
        costSource:
          priced.costSource === "providerReported"
            ? ("provider-reported" as const)
            : ("model-priced" as const),
      };
    });

    const deriveTurn = Effect.fn("SkillUsageService.deriveTurn")(function* (row: PendingTurnRow) {
      const resolution = yield* decodeResolution(row.resolution_json);
      const available = yield* decodeAvailable(row.available_json);
      const run = yield* decodeRun(row.run_payload_json);
      const itemRows = yield* sql<TurnItemRow>`
        SELECT turn_item_id, updated_at, payload_json
        FROM orchestration_v2_projection_turn_items
        WHERE run_id = ${row.run_id}
        ORDER BY ordinal ASC, turn_item_id ASC
        LIMIT ${MAX_TURN_ITEMS_PER_RUN}
      `;
      const decodedItems = yield* Effect.forEach(
        itemRows,
        (itemRow) =>
          decodeTurnItem(itemRow.payload_json).pipe(Effect.map((item) => ({ item, row: itemRow }))),
        { concurrency: 1 },
      );
      const userMessageRows = yield* sql<PayloadRow>`
        SELECT payload_json
        FROM orchestration_v2_projection_messages
        WHERE message_id = ${run.userMessageId}
        LIMIT 1
      `;
      const userMessage =
        userMessageRows[0] === undefined
          ? null
          : yield* decodeMessage(userMessageRows[0].payload_json);
      const providerTurnRows = yield* sql<PayloadRow>`
        SELECT turn.payload_json
        FROM orchestration_v2_projection_provider_turns AS turn
        JOIN orchestration_v2_projection_run_attempts AS attempt
          ON attempt.attempt_id = turn.run_attempt_id
        WHERE attempt.run_id = ${row.run_id}
        ORDER BY attempt.attempt_ordinal DESC, turn.ordinal DESC, turn.provider_turn_id DESC
        LIMIT 1
      `;
      const latestProviderTurn =
        providerTurnRows[0] === undefined
          ? null
          : yield* decodeProviderTurn(providerTurnRows[0].payload_json);
      const names = new Map<
        string,
        {
          readonly skillName: string;
          readonly variantPath: string | null;
          readonly basePaths: Set<string>;
        }
      >();
      for (const entry of resolution.entries) {
        names.set(entry.skillName.toLowerCase(), {
          skillName: entry.skillName,
          variantPath: entry.variantPath,
          basePaths: new Set(),
        });
      }
      for (const skill of available) {
        const key = skill.name.toLowerCase();
        const existing = names.get(key);
        if (existing === undefined) {
          names.set(key, {
            skillName: skill.name,
            variantPath: null,
            basePaths: new Set(skill.path.length === 0 ? [] : [skill.path]),
          });
        } else if (skill.path.length > 0) {
          existing.basePaths.add(skill.path);
        }
      }

      const evidence: SkillTurnEvidence[] = [];
      for (const candidate of names.values()) {
        const normalizedName = candidate.skillName.toLowerCase();
        if (
          userMessage !== null &&
          ([...matchInlineSkills(userMessage.text.toLowerCase(), [{ name: normalizedName }])]
            .length > 0 ||
            mentionsSlashSkill(userMessage.text, normalizedName))
        ) {
          evidence.push(
            SkillTurnEvidence.make({
              runId: run.id,
              skillName: candidate.skillName,
              kind: "requested",
              source: "user_mention",
              turnItemId: null,
              observedAt: DateTime.formatIso(userMessage.createdAt),
            }),
          );
        }

        for (const { item, row: itemRow } of decodedItems) {
          const payload = itemRow.payload_json;
          const normalizedPayload = pathPayload(payload);
          const normalizedVariantPath =
            candidate.variantPath === null ? null : pathPayload(candidate.variantPath);
          const normalizedBasePaths = [...candidate.basePaths].map(pathPayload);
          const variantRead =
            normalizedVariantPath !== null && normalizedPayload.includes(normalizedVariantPath);
          const baseRead = normalizedBasePaths.some((skillPath) =>
            normalizedPayload.includes(skillPath),
          );
          if (variantRead) {
            evidence.push(
              SkillTurnEvidence.make({
                runId: run.id,
                skillName: candidate.skillName,
                kind: "activated",
                source: "variant_file_read",
                turnItemId: item.id,
                observedAt: itemRow.updated_at,
              }),
            );
          }
          if (!variantRead && baseRead) {
            evidence.push(
              SkillTurnEvidence.make({
                runId: run.id,
                skillName: candidate.skillName,
                kind: "activated",
                source: "skill_file_read",
                turnItemId: item.id,
                observedAt: itemRow.updated_at,
              }),
            );
          }
          if (
            item.type === "dynamic_tool" &&
            item.toolName?.toLowerCase() === "skill" &&
            matchesNativeSkillName(item.input, normalizedName)
          ) {
            evidence.push(
              SkillTurnEvidence.make({
                runId: run.id,
                skillName: candidate.skillName,
                kind: "activated",
                source: "native_skill_tool",
                turnItemId: item.id,
                observedAt: itemRow.updated_at,
              }),
            );
          }
          const resourceDirectories = [
            ...(normalizedVariantPath === null ? [] : [skillDirectory(normalizedVariantPath)]),
            ...normalizedBasePaths.map(skillDirectory),
          ].filter((directory) => directory.length > 0);
          if (
            !variantRead &&
            !baseRead &&
            resourceDirectories.some((directory) => normalizedPayload.includes(directory))
          ) {
            evidence.push(
              SkillTurnEvidence.make({
                runId: run.id,
                skillName: candidate.skillName,
                kind: "applied",
                source: "skill_resource",
                turnItemId: item.id,
                observedAt: itemRow.updated_at,
              }),
            );
          }
          if (item.type === "assistant_message" && mentionsSkill(item.text, normalizedName)) {
            evidence.push(
              SkillTurnEvidence.make({
                runId: run.id,
                skillName: candidate.skillName,
                kind: "claimed",
                source: "assistant_mention",
                turnItemId: item.id,
                observedAt: itemRow.updated_at,
              }),
            );
          }
        }
      }

      const toolCalls = decodedItems.reduce(
        (count, { item }) => count + (isToolItem(item.type) ? 1 : 0),
        0,
      );
      const toolFailures = decodedItems.reduce(
        (count, { item }) => count + (isToolFailure(item) ? 1 : 0),
        0,
      );
      const errors = decodedItems.reduce(
        (count, { item }) => count + (item.type === "error" ? 1 : 0),
        0,
      );
      const startedAt = run.startedAt ?? run.requestedAt;
      const durationMs =
        run.completedAt === null
          ? null
          : Math.max(
              0,
              DateTime.toEpochMillis(run.completedAt) - DateTime.toEpochMillis(startedAt),
            );
      const storedStatus = run.status === "rolled_back" ? "completed" : run.status;
      if (
        storedStatus !== "completed" &&
        storedStatus !== "interrupted" &&
        storedStatus !== "failed" &&
        storedStatus !== "cancelled"
      ) {
        return null;
      }
      const tokens = tokenUsage(latestProviderTurn);
      const cost = yield* priceTurn(row.model, tokens, providerReportedCost(latestProviderTurn));
      const outcome = SkillTurnOutcome.make({
        status: storedStatus,
        durationMs,
        toolCalls,
        toolFailures,
        errors,
        tokens,
        ...cost,
        reverted: false,
        followupCorrection: null,
      });
      return { evidence, outcome };
    });

    const finalizeTurn = Effect.fn("SkillUsageService.finalizeTurn")(function* (
      row: PendingTurnRow,
    ) {
      const derived = yield* deriveTurn(row);
      if (derived === null) return false;
      const finalizedAt = DateTime.formatIso(yield* DateTime.now);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const item of derived.evidence) yield* insertEvidence(item);
          const updated = yield* sql<{ readonly run_id: string }>`
            UPDATE skill_turns
            SET outcome_json = ${encodeOutcome(derived.outcome)},
                finalized_at = ${finalizedAt}
            WHERE run_id = ${row.run_id}
              AND finalized_at IS NULL
            RETURNING run_id
          `;
          if (
            updated.length > 0 &&
            derived.evidence.some(
              (evidence) => evidence.kind === "activated" || evidence.kind === "applied",
            )
          ) {
            yield* sql`
              INSERT OR IGNORE INTO skill_activated_provider_threads (
                provider_thread_id,
                first_activated_at
              )
              SELECT provider_thread_id, ${finalizedAt}
              FROM orchestration_v2_projection_runs
              WHERE run_id = ${row.run_id}
                AND provider_thread_id IS NOT NULL
            `;
          }
          return updated.length > 0;
        }),
      );
    });

    const finalizeRun = Effect.fn("SkillUsageService.finalizeRun")(
      function* (runId: RunId) {
        const rows = yield* sql<PendingTurnRow>`
          SELECT
            turn.run_id,
            turn.thread_id,
            turn.instance_id,
            turn.driver,
            turn.model,
            turn.delivery,
            turn.resolution_json,
            turn.available_json,
            turn.eval_trial_id,
            turn.created_at,
            turn.outcome_json,
            turn.finalized_at,
            run.status AS run_status,
            run.payload_json AS run_payload_json
          FROM skill_turns AS turn
          JOIN orchestration_v2_projection_runs AS run ON run.run_id = turn.run_id
          WHERE turn.run_id = ${runId}
            AND turn.finalized_at IS NULL
            AND run.status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
          LIMIT 1
        `;
        const row = rows[0];
        return row === undefined ? false : yield* finalizeTurn(row);
      },
      Effect.mapError((cause) => persistenceError("finalize a skill turn", cause)),
    );

    const finalizePending = Effect.fn("SkillUsageService.finalizePending")(
      function* (limit: number) {
        const boundedLimit = Math.max(0, Math.min(500, Math.trunc(limit)));
        if (boundedLimit === 0) return 0;
        const rows = yield* sql<PendingTurnRow>`
        SELECT
          turn.run_id,
          turn.thread_id,
          turn.instance_id,
          turn.driver,
          turn.model,
          turn.delivery,
          turn.resolution_json,
          turn.available_json,
          turn.eval_trial_id,
          turn.created_at,
          turn.outcome_json,
          turn.finalized_at,
          run.status AS run_status,
          run.payload_json AS run_payload_json
        FROM skill_turns AS turn
        JOIN orchestration_v2_projection_runs AS run ON run.run_id = turn.run_id
        WHERE turn.finalized_at IS NULL
          AND run.status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
        ORDER BY turn.created_at ASC, turn.run_id ASC
        LIMIT ${boundedLimit}
      `;
        let finalized = 0;
        for (const row of rows) finalized += (yield* finalizeTurn(row)) ? 1 : 0;
        return finalized;
      },
      Effect.mapError((cause) => persistenceError("finalize pending skill turns", cause)),
    );

    const activatedOnProviderThread = Effect.fn("SkillUsageService.activatedOnProviderThread")(
      function* (providerThreadId: ProviderThreadId) {
        const marker = yield* sql<ActivatedProviderThreadRow>`
          SELECT provider_thread_id
          FROM skill_activated_provider_threads
          WHERE provider_thread_id = ${providerThreadId}
          LIMIT 1
        `.pipe(NodeSqliteClient.readOnly);
        // Finalization (which writes the marker) runs after commit, so a just-finished run may
        // not be marked yet. Derive only the thread's latest runs in memory to close that window.
        const pending = yield* sql<PendingTurnRow>`
          SELECT
            turn.run_id,
            turn.thread_id,
            turn.instance_id,
            turn.driver,
            turn.model,
            turn.delivery,
            turn.resolution_json,
            turn.available_json,
            turn.eval_trial_id,
            turn.created_at,
            turn.outcome_json,
            turn.finalized_at,
            run.status AS run_status,
            run.payload_json AS run_payload_json
          FROM (
            SELECT run_id, status, payload_json
            FROM orchestration_v2_projection_runs
            WHERE provider_thread_id = ${providerThreadId}
            ORDER BY ordinal DESC
            LIMIT ${MAX_PENDING_PROVIDER_THREAD_TURNS}
          ) AS run
          JOIN skill_turns AS turn ON turn.run_id = run.run_id
          WHERE turn.finalized_at IS NULL
            AND run.status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
          ORDER BY turn.created_at DESC, turn.run_id DESC
        `.pipe(NodeSqliteClient.readOnly);
        const pendingContexts: ActivatedContextRow[] = [];
        for (const row of pending) {
          const derived = yield* deriveTurn(row).pipe(NodeSqliteClient.readOnly);
          if (derived === null) continue;
          for (const evidence of derived.evidence) {
            if (evidence.kind !== "activated" && evidence.kind !== "applied") continue;
            pendingContexts.push({
              resolution_json: row.resolution_json,
              available_json: row.available_json,
              skill_name: evidence.skillName,
            });
          }
        }
        if (marker.length === 0 && pendingContexts.length === 0) return [];

        const rows =
          marker.length === 0
            ? []
            : yield* sql<ActivatedContextRow>`
          SELECT DISTINCT turn.resolution_json, turn.available_json, evidence.skill_name
          FROM skill_turns AS turn
          JOIN orchestration_v2_projection_runs AS run ON run.run_id = turn.run_id
          JOIN skill_turn_evidence AS evidence ON evidence.run_id = turn.run_id
          WHERE run.provider_thread_id = ${providerThreadId}
            AND evidence.kind IN ('activated', 'applied')
          ORDER BY lower(evidence.skill_name), turn.created_at, turn.run_id
        `.pipe(NodeSqliteClient.readOnly);
        const contexts = new Map<string, ActivatedSkillContext>();
        for (const row of [...rows, ...pendingContexts]) {
          const resolution = yield* decodeResolution(row.resolution_json);
          const available = yield* decodeAvailable(row.available_json);
          const skillName = row.skill_name.trim().toLowerCase();
          const entry = resolution.entries.find(
            (candidate) => candidate.skillName.toLowerCase() === skillName,
          );
          const context = {
            skillName,
            mode: entry?.mode ?? "base",
            contentHash: entry?.contentHash ?? null,
            variantPath: entry?.variantPath ?? null,
            skillPath:
              available.find((candidate) => candidate.name.toLowerCase() === skillName)?.path ||
              null,
          } satisfies ActivatedSkillContext;
          contexts.set(
            `${context.skillName}\0${context.mode}\0${context.contentHash ?? ""}\0${context.variantPath ?? ""}\0${context.skillPath ?? ""}`,
            context,
          );
        }
        return [...contexts.values()];
      },
      Effect.mapError((cause) =>
        persistenceError("load activated skills for a provider thread", cause),
      ),
    );

    const followupCorrection = Effect.fn("SkillUsageService.followupCorrection")(function* (
      row: SkillTurnRow,
    ) {
      const runRows = yield* sql<PayloadRow>`
        SELECT payload_json
        FROM orchestration_v2_projection_runs
        WHERE run_id = ${row.run_id}
        LIMIT 1
      `;
      if (runRows[0] === undefined) return null;
      const run = yield* decodeRun(runRows[0].payload_json);
      const message = yield* nextUserMessage(run.threadId, run.ordinal);
      return message === null ? null : FOLLOWUP_CORRECTION.test(message.text);
    });

    const loadRecords = Effect.fn("SkillUsageService.loadRecords")(function* (
      rows: readonly SkillTurnRow[],
    ) {
      const records: SkillTurnRecord[] = [];
      for (const row of rows) {
        const evidenceRows = yield* sql<EvidenceRow>`
          SELECT run_id, skill_name, kind, source, turn_item_id, observed_at
          FROM skill_turn_evidence
          WHERE run_id = ${row.run_id}
          ORDER BY skill_name, kind, source
        `;
        const storedOutcome =
          row.outcome_json === null ? null : yield* decodeOutcome(row.outcome_json);
        const outcome =
          storedOutcome === null
            ? null
            : {
                ...storedOutcome,
                reverted: row.run_status === "rolled_back",
                followupCorrection: yield* followupCorrection(row),
              };
        records.push({
          runId: RunId.make(row.run_id),
          threadId: ThreadId.make(row.thread_id),
          instanceId: ProviderInstanceId.make(row.instance_id),
          driver: ProviderDriverKind.make(row.driver),
          model: row.model,
          delivery: row.delivery,
          resolution: yield* decodeResolution(row.resolution_json),
          available: yield* decodeAvailable(row.available_json),
          evalTrialId: row.eval_trial_id,
          createdAt: row.created_at,
          outcome,
          finalizedAt: row.finalized_at,
          evidence: yield* Effect.forEach(evidenceRows, evidenceFromRow, { concurrency: 1 }),
        });
      }
      return records;
    });

    const recordTurnStart = Effect.fn("SkillUsageService.recordTurnStart")(
      function* (input: SkillTurnStartInput) {
        const now = DateTime.formatIso(yield* DateTime.now);
        const evalRows = yield* sql<EvalTrialRow>`
        SELECT trial_id
        FROM skill_eval_trials
        WHERE thread_id = ${input.threadId}
        ORDER BY created_at DESC
        LIMIT 1
      `;
        yield* sql`
        INSERT OR IGNORE INTO skill_turns (
          run_id,
          thread_id,
          instance_id,
          driver,
          model,
          delivery,
          resolution_json,
          available_json,
          eval_trial_id,
          created_at,
          outcome_json,
          finalized_at
        ) VALUES (
          ${input.runId},
          ${input.threadId},
          ${input.instanceId},
          ${input.driver},
          ${input.model},
          ${input.delivery},
          ${encodeResolution(input.resolution)},
          ${encodeAvailable(normalizedAvailableSkills(input.available))},
          ${evalRows[0]?.trial_id ?? null},
          ${now},
          NULL,
          NULL
        )
      `;
      },
      Effect.mapError((cause) => persistenceError("record a skill turn", cause)),
    );

    const listTurns = Effect.fn("SkillUsageService.listTurns")(
      function* (input: SkillTurnListInput) {
        yield* finalizePending(FINALIZE_READ_LIMIT);
        const boundedLimit = Math.max(0, Math.min(500, Math.trunc(input.limit)));
        if (boundedLimit === 0) return [];
        const skillName = input.skillName?.trim().toLowerCase();
        const rows = yield* sql<SkillTurnRow>`
        SELECT
          turn.run_id,
          turn.thread_id,
          turn.instance_id,
          turn.driver,
          turn.model,
          turn.delivery,
          turn.resolution_json,
          turn.available_json,
          turn.eval_trial_id,
          turn.created_at,
          turn.outcome_json,
          turn.finalized_at,
          run.status AS run_status
        FROM skill_turns AS turn
        LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = turn.run_id
        WHERE (${input.driver ?? null} IS NULL OR turn.driver = ${input.driver ?? null})
          AND (${input.model ?? null} IS NULL OR lower(turn.model) = lower(${input.model ?? null}))
          AND (
            ${skillName ?? null} IS NULL
            OR EXISTS (
              SELECT 1
              FROM json_each(turn.resolution_json, '$.entries') AS entry
              WHERE lower(json_extract(entry.value, '$.skillName')) = ${skillName ?? null}
            )
            OR EXISTS (
              SELECT 1
              FROM json_each(turn.available_json) AS available
              WHERE lower(
                CASE
                  WHEN available.type = 'object'
                    THEN json_extract(available.value, '$.name')
                  ELSE available.value
                END
              ) = ${skillName ?? null}
            )
          )
        ORDER BY turn.created_at DESC, turn.run_id DESC
        LIMIT ${boundedLimit}
      `.pipe(NodeSqliteClient.readOnly);
        return yield* loadRecords(rows).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError((cause) => persistenceError("list skill turns", cause)),
    );

    const observational = Effect.fn("SkillUsageService.observational")(
      function* (input: { readonly skillName: string }) {
        const records = yield* listTurns({ skillName: input.skillName, limit: 500 });
        const normalizedName = input.skillName.trim().toLowerCase();
        const turns: ObservationalTurn[] = [];
        for (const record of records) {
          if (record.outcome === null || record.evalTrialId !== null) continue;
          const entry = record.resolution.entries.find(
            (candidate) => candidate.skillName.toLowerCase() === normalizedName,
          );
          const available = record.available.some(
            (skill) => skill.name.toLowerCase() === normalizedName,
          );
          const mode: ObservationalMode | null =
            entry?.mode === "variant"
              ? "variant"
              : entry?.mode === "off"
                ? "off"
                : available
                  ? "base-available"
                  : null;
          if (mode === null) continue;
          turns.push({
            skillName: entry?.skillName ?? input.skillName,
            driver: record.driver,
            model: record.model,
            mode,
            activated: record.evidence.some(
              (evidence) =>
                evidence.skillName.toLowerCase() === normalizedName &&
                evidence.kind === "activated",
            ),
            status: record.outcome.status,
            reverted: record.outcome.reverted,
            toolCalls: record.outcome.toolCalls,
            toolFailures: record.outcome.toolFailures,
            tokens: observationalTokenCount(record.outcome),
            durationMs: record.outcome.durationMs,
          });
        }
        return observationalSummary(turns);
      },
      Effect.mapError((cause) => persistenceError("summarize observational skill turns", cause)),
    );

    return {
      recordTurnStart,
      finalizeRun,
      finalizePending,
      listTurns,
      activatedOnProviderThread,
      observational,
    };
  }),
);
