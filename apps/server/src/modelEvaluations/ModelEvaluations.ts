import {
  BlindModelEvaluationPacket,
  MessageId,
  ModelEvaluationError,
  ModelEvaluationRecord,
  ModelSelection,
  type ModelEvaluationGuidance,
  type ModelEvaluationReport,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  MODEL_EVALUATION_RUBRIC_VERSION,
  buildModelEvaluationEvidence,
  validateModelEvaluationVerdict,
} from "@t3tools/provider-core/server/modelEvaluation";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { modelEvaluationEffects } from "./modelEvaluationSchedule.ts";

const WINDOW_LIMIT = 200;
const HISTORY_LIMIT = 50;
const GUIDANCE_LIMIT = 20;
const DIMENSIONS = [
  "taskCompletion",
  "correctness",
  "instructionFollowing",
  "verification",
] as const;
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(ModelEvaluationRecord));
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelEvaluationRecord));
const encodePacket = Schema.encodeSync(
  Schema.fromJsonString(Schema.NullOr(BlindModelEvaluationPacket)),
);
const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(MessageId)));
const decodeSelection = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));
const isModelEvaluationError = Schema.is(ModelEvaluationError);

function selectionKey(selection: ModelSelection) {
  return JSON.stringify({
    instanceId: selection.instanceId,
    model: selection.model,
    options: (selection.options ?? []).toSorted((a, b) => a.id.localeCompare(b.id)),
  });
}

function summarize(
  records: ReadonlyArray<ModelEvaluationRecord>,
): ReadonlyArray<ModelEvaluationGuidance> {
  const groups = new Map<string, ModelEvaluationRecord[]>();
  for (const record of records) {
    if (record.verdict === null || !["scored", "insufficient_evidence"].includes(record.status))
      continue;
    const key = JSON.stringify([
      selectionKey(record.modelSelection),
      selectionKey(record.evaluatorSelection),
      record.rubricVersion,
      record.scope,
      record.verdict.taskCategory,
    ]);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return [...groups.values()].slice(0, GUIDANCE_LIMIT).map((group) => {
    const first = group[0]!;
    const scored = group.filter((record) => record.status === "scored");
    const meanScores = {
      taskCompletion: null,
      correctness: null,
      instructionFollowing: null,
      verification: null,
    } as ModelEvaluationGuidance["meanScores"];
    const scoreCounts = {
      taskCompletion: 0,
      correctness: 0,
      instructionFollowing: 0,
      verification: 0,
    };
    for (const dimension of DIMENSIONS) {
      const values = scored.flatMap((record) => record.verdict?.scores[dimension] ?? []);
      scoreCounts[dimension] = values.length;
      Object.assign(meanScores, {
        [dimension]:
          values.length === 0
            ? null
            : values.reduce((sum, value) => sum + value, 0) / values.length,
      });
    }
    const prompts = scored.map((record) => record.promptChars).toSorted((a, b) => a - b);
    const observations = (field: "strengths" | "weaknesses" | "promptAdvice") =>
      [
        ...new Set(
          scored.flatMap(
            (record) =>
              record.verdict?.[field].map((observation) =>
                observation.text.replace(/\s+/g, " ").trim().slice(0, 240),
              ) ?? [],
          ),
        ),
      ].slice(0, 3);
    return {
      scope: first.scope,
      modelSelection: first.modelSelection,
      evaluatorSelection: first.evaluatorSelection,
      rubricVersion: first.rubricVersion,
      taskCategory: first.verdict!.taskCategory,
      sampleCount: scored.length,
      insufficientEvidenceCount: group.length - scored.length,
      meanScores,
      scoreCounts,
      confidence:
        scored.filter((record) => record.verdict?.confidence !== "low").length >= 5
          ? "observed"
          : "provisional",
      promptChars: {
        min: prompts[0] ?? 0,
        median:
          prompts.length === 0
            ? 0
            : ((prompts[Math.floor((prompts.length - 1) / 2)] ?? 0) +
                (prompts[Math.floor(prompts.length / 2)] ?? 0)) /
              2,
        max: prompts.at(-1) ?? 0,
      },
      strengths: observations("strengths"),
      weaknesses: observations("weaknesses"),
      promptAdvice: observations("promptAdvice"),
      latestAt: first.at,
    };
  });
}

export class ModelEvaluationPassError extends Schema.TaggedError<ModelEvaluationPassError>()(
  "ModelEvaluationPassError",
  { runId: Schema.String, cause: Schema.Defect() },
) {}

type RunInput = Pick<ModelEvaluationRecord, "threadId" | "runId" | "runOutcome">;

export class ModelEvaluations extends Context.Service<
  ModelEvaluations,
  {
    readonly enqueueRun: (input: RunInput) => Effect.Effect<void, ModelEvaluationPassError>;
    readonly evaluateRun: (input: RunInput) => Effect.Effect<void, ModelEvaluationPassError>;
    readonly list: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<ModelEvaluationReport, ModelEvaluationError>;
    readonly clear: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<void, ModelEvaluationError>;
    readonly guidance: (input: {
      readonly projectId: ProjectId;
      readonly models?: ReadonlyArray<Pick<ModelSelection, "instanceId" | "model">>;
    }) => Effect.Effect<ReadonlyArray<ModelEvaluationGuidance>, ModelEvaluationError>;
  }
>()("t3/modelEvaluations/ModelEvaluations") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const fs = yield* FileSystem.FileSystem;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const generationLock = yield* Semaphore.make(1);

  const requireProject = Effect.fn("ModelEvaluations.requireProject")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects.get(projectId);
    if (Option.isNone(project) || project.value.deletedAt !== null)
      return yield* new ModelEvaluationError({ projectId, reason: "missing_project" });
    return project.value;
  });
  const mapError = (projectId: ProjectId) => (cause: unknown) =>
    isModelEvaluationError(cause)
      ? cause
      : new ModelEvaluationError({ projectId, reason: "storage", cause });
  const reset = Effect.fn("ModelEvaluations.resetState")(function* (projectId: ProjectId) {
    const rows = yield* sql<{
      generation: number;
      reset_at: string;
    }>`SELECT generation, reset_at FROM model_evaluation_resets WHERE project_id = ${projectId}`;
    return rows[0] ?? { generation: 0, reset_at: "" };
  });
  const loadSource = Effect.fn("ModelEvaluations.loadSource")(function* (
    threadId: ThreadId,
    runId: RunId,
  ) {
    const records = yield* projections
      .getThreadRecords(threadId, ["runs", "messages", "turnItems"], {
        runIds: [runId],
        messageRunIds: [runId],
        turnItemRunIds: [runId],
      })
      .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }));
    const run = records?.runs.find((candidate) => candidate.id === runId);
    if (
      records === null ||
      run === undefined ||
      records.thread.deletedAt !== null ||
      records.thread.archivedAt !== null ||
      run.status === "rolled_back"
    )
      return null;
    const request = yield* projections.getThreadRecords(threadId, ["messages"], {
      messageIds: [run.userMessageId],
    });
    const user = request.messages[0];
    const prior =
      user === undefined
        ? []
        : yield* sql<{ message_id: string }>`
      SELECT message.message_id FROM orchestration_v2_projection_messages AS message
      LEFT JOIN orchestration_v2_projection_runs AS source_run ON source_run.run_id = message.run_id
      WHERE message.thread_id = ${threadId} AND message.created_at < ${DateTime.formatIso(user.createdAt)}
        AND message.role IN ('user', 'assistant') AND message.streaming = 0
        AND (source_run.status IS NULL OR source_run.status <> 'rolled_back')
        AND NOT (source_run.status IS 'cancelled' AND json_extract(source_run.payload_json, '$.startedAt') IS NULL)
      ORDER BY message.created_at DESC, message.message_id DESC LIMIT 8
    `;
    const context =
      prior.length === 0
        ? []
        : (yield* projections.getThreadRecords(threadId, ["messages"], {
            messageIds: prior.map((row) => MessageId.make(row.message_id)),
          })).messages;
    const messages = [
      ...new Map(
        [...context, ...request.messages, ...records.messages].map((message) => [
          message.id,
          message,
        ]),
      ).values(),
    ];
    return { ...records, run, messages };
  });
  const sequence = Effect.fn("ModelEvaluations.sourceSequence")(function* (threadId: ThreadId) {
    const rows = yield* sql<{
      sequence: number;
    }>`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}`;
    return rows[0]!.sequence;
  });
  const attributionKnown = Effect.fn("ModelEvaluations.attributionKnown")(function* (
    threadId: ThreadId,
    runId: RunId,
    selection: ModelSelection,
  ) {
    if (/^(auto|default)$/i.test(selection.model)) return false;
    const rows = yield* sql<{ model_selection: string }>`
      SELECT DISTINCT json_extract(payload_json, '$.modelSelection') AS model_selection
      FROM orchestration_events WHERE application_event_version = 2 AND aggregate_kind = 'thread'
        AND stream_id = ${threadId} AND event_type = 'run.updated'
        AND json_extract(payload_json, '$.id') = ${runId}
        AND json_extract(payload_json, '$.status') IN ('running', 'waiting', 'completed')
    `;
    const selections = yield* Effect.forEach(rows, (row) => decodeSelection(row.model_selection));
    return selections.every((value) => selectionKey(value) === selectionKey(selection));
  });
  const readRecords = Effect.fn("ModelEvaluations.readRecords")(function* (projectId: ProjectId) {
    const after = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 90 }));
    const rows = yield* sql<{ payload_json: string }>`
      SELECT evaluation.payload_json FROM model_evaluations AS evaluation
      JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = evaluation.thread_id
      JOIN orchestration_v2_projection_runs AS run ON run.run_id = evaluation.run_id
      WHERE evaluation.project_id = ${projectId} AND thread.project_id = ${projectId}
        AND thread.deleted_at IS NULL AND thread.archived_at IS NULL AND run.status <> 'rolled_back'
        AND evaluation.evaluated_at >= ${after}
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_events AS source
          WHERE source.application_event_version = 2 AND source.aggregate_kind = 'thread'
            AND source.stream_id = evaluation.thread_id AND source.sequence > evaluation.source_sequence
            AND source.event_type IN ('message.updated', 'turn-item.updated')
            AND json_extract(source.payload_json, '$.runId') = evaluation.run_id
            AND (source.event_type = 'message.updated' OR json_extract(source.payload_json, '$.type') IN ('user_message', 'assistant_message', 'command_execution', 'file_change', 'dynamic_tool', 'subagent'))
        )
        AND NOT EXISTS (
          SELECT 1 FROM json_each(evaluation.source_message_ids) AS message
          JOIN orchestration_events AS source
            ON json_extract(source.payload_json, '$.id') = message.value
          WHERE source.application_event_version = 2 AND source.aggregate_kind = 'thread'
            AND source.stream_id = evaluation.thread_id AND source.event_type = 'message.updated'
            AND source.sequence > evaluation.source_sequence
        )
        AND NOT EXISTS (
          SELECT 1 FROM json_each(evaluation.source_message_ids) AS reference
          LEFT JOIN orchestration_v2_projection_messages AS message ON message.message_id = reference.value
          LEFT JOIN orchestration_v2_projection_runs AS source_run ON source_run.run_id = message.run_id
          WHERE message.message_id IS NULL OR message.thread_id <> evaluation.thread_id
            OR source_run.status = 'rolled_back'
            OR (source_run.status = 'cancelled' AND json_extract(source_run.payload_json, '$.startedAt') IS NULL)
        )
      ORDER BY evaluation.evaluated_at DESC, evaluation.run_id DESC LIMIT ${WINDOW_LIMIT}
    `;
    return yield* Effect.forEach(rows, (row) => decodeRecord(row.payload_json));
  });

  const list: ModelEvaluations["Service"]["list"] = Effect.fn("ModelEvaluations.list")(
    function* ({ projectId }) {
      yield* requireProject(projectId);
      const records = yield* readRecords(projectId);
      const current = yield* settings.getSettings;
      return {
        projectId,
        enabled: current.enableModelEvaluations,
        records: records.slice(0, HISTORY_LIMIT),
        guidance: summarize(records),
        windowLimit: WINDOW_LIMIT,
      };
    },
    (effect, { projectId }) => effect.pipe(Effect.mapError(mapError(projectId))),
  );
  const guidance: ModelEvaluations["Service"]["guidance"] = Effect.fn("ModelEvaluations.guidance")(
    function* ({ projectId, models }) {
      if (!(yield* settings.getSettings).enableModelEvaluations) return [];
      if (models?.length === 0) return [];
      yield* requireProject(projectId);
      const records = yield* readRecords(projectId);
      return summarize(
        models === undefined
          ? records
          : records.filter((record) =>
              models.some(
                (selection) =>
                  selection.instanceId === record.modelSelection.instanceId &&
                  selection.model === record.modelSelection.model,
              ),
            ),
      );
    },
    (effect, { projectId }) => effect.pipe(Effect.mapError(mapError(projectId))),
  );
  const clear: ModelEvaluations["Service"]["clear"] = Effect.fn("ModelEvaluations.clear")(
    function* ({ projectId }) {
      yield* requireProject(projectId);
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO model_evaluation_resets (project_id, generation, reset_at) VALUES (${projectId}, 1, ${at})
          ON CONFLICT (project_id) DO UPDATE SET generation = generation + 1, reset_at = excluded.reset_at`;
          yield* sql`DELETE FROM model_evaluations WHERE project_id = ${projectId}`;
        }),
      );
    },
    (effect, { projectId }) => effect.pipe(Effect.mapError(mapError(projectId))),
  );

  const enqueueRun: ModelEvaluations["Service"]["enqueueRun"] = Effect.fn(
    "ModelEvaluations.enqueueRun",
  )(
    function* (input) {
      const effects = modelEvaluationEffects({ ...input, settings: yield* settings.getSettings });
      if (effects.length === 0) return;
      yield* outbox.enqueue(effects);
      yield* outbox.notifyAvailable(effects.length);
    },
    (effect, { runId }) =>
      effect.pipe(Effect.mapError((cause) => new ModelEvaluationPassError({ runId, cause }))),
  );

  const evaluateRun: ModelEvaluations["Service"]["evaluateRun"] = Effect.fn(
    "ModelEvaluations.evaluateRun",
  )(
    function* ({ threadId, runId, runOutcome: requestedOutcome }) {
      const initial = yield* settings.getSettings;
      if (!initial.enableModelEvaluations) return;
      const source = yield* sql.withTransaction(
        Effect.gen(function* () {
          const records = yield* loadSource(threadId, runId);
          return { records, sourceSequence: yield* sequence(threadId) };
        }),
      );
      const records = source.records;
      if (records === null) return;
      const projectId = records.thread.projectId;
      const runOutcome =
        records.run.status === "completed" ||
        records.run.status === "failed" ||
        records.run.status === "interrupted" ||
        records.run.status === "cancelled"
          ? records.run.status
          : requestedOutcome;
      const settled = ["completed", "failed", "interrupted", "cancelled"].includes(
        records.run.status,
      );
      yield* requireProject(projectId);
      const previous = yield* sql`SELECT run_id FROM model_evaluations WHERE run_id = ${runId}`;
      if (previous.length > 0) return;
      const generation = yield* reset(projectId);
      if (DateTime.formatIso(records.run.requestedAt) <= generation.reset_at) return;
      const evaluatorSelection =
        initial.modelEvaluationModelSelection ?? initial.textGenerationModelSelection;
      const provider = (yield* providers.getPublishedProviders).find(
        (candidate) => candidate.instanceId === records.run.providerInstanceId,
      );
      const candidateModel = provider?.models.find(
        (model) =>
          model.slug === records.run.modelSelection.model ||
          model.aliases?.includes(records.run.modelSelection.model),
      );
      const aliases = [
        records.run.modelSelection.model,
        records.run.providerInstanceId,
        provider?.displayName,
        provider?.driver,
        candidateModel?.name,
        candidateModel?.shortName,
        candidateModel?.subProvider,
        ...(candidateModel?.aliases ?? []),
      ].filter((value): value is string => value !== undefined);
      const scope =
        records.thread.lineage.relationshipToParent === "subagent" ||
        records.run.delegatedTaskId !== undefined
          ? "subagent"
          : "turn";
      const build = (value: NonNullable<typeof records>) =>
        buildModelEvaluationEvidence({
          run: value.run,
          messages: value.messages,
          turnItems: value.turnItems,
          identityAliases: aliases,
          scope,
          runOutcome,
        });
      const evidence = build(records);
      const attributed =
        records.run.providerInstanceId === records.run.modelSelection.instanceId &&
        (yield* attributionKnown(threadId, runId, records.run.modelSelection));
      let status: ModelEvaluationRecord["status"] = "skipped";
      let reason: string | null = "The run has no complete request and final response to evaluate.";
      let verdict: ModelEvaluationRecord["verdict"] = null;
      if (!attributed)
        reason = "The executed model could not be attributed to one stable model selection.";
      if (!settled)
        reason = "The run could not finish checkpoint finalization. No model score was recorded.";
      if (evidence !== null && attributed && settled) {
        const generated = yield* Effect.gen(function* () {
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-model-evaluation-" });
          return yield* textGeneration.generateModelEvaluation({
            cwd,
            modelSelection: evaluatorSelection,
            packet: evidence.packet,
          });
        }).pipe(
          Effect.scoped,
          Effect.catchTags({ TextGenerationError: () => Effect.succeed(null) }),
        );
        if (generated === null) {
          status = "failed";
          reason = "The evaluator could not complete this evaluation. No model score was recorded.";
        } else if (!validateModelEvaluationVerdict(generated, evidence.packet)) {
          status = "failed";
          reason =
            "The evaluator returned unsupported scores or evidence references. No model score was recorded.";
        } else {
          verdict = generated;
          status = verdict.outcome;
          reason = null;
        }
      }
      yield* settings.withSettingsSnapshot((current) =>
        sql.withTransaction(
          Effect.gen(function* () {
            if (
              !current.enableModelEvaluations ||
              selectionKey(
                current.modelEvaluationModelSelection ?? current.textGenerationModelSelection,
              ) !== selectionKey(evaluatorSelection)
            )
              return;
            const latestGeneration = yield* reset(projectId);
            if (latestGeneration.generation !== generation.generation) return;
            const latest = yield* loadSource(threadId, runId);
            if (
              latest === null ||
              latest.thread.projectId !== projectId ||
              latest.run.status !== records.run.status ||
              selectionKey(latest.run.modelSelection) !== selectionKey(records.run.modelSelection)
            )
              return;
            const latestEvidence = build(latest);
            if (
              encodePacket(latestEvidence?.packet ?? null) !==
              encodePacket(evidence?.packet ?? null)
            )
              return;
            yield* requireProject(projectId);
            const record: ModelEvaluationRecord = {
              projectId,
              threadId,
              runId,
              scope,
              runOutcome,
              modelSelection: records.run.modelSelection,
              evaluatorSelection,
              rubricVersion: MODEL_EVALUATION_RUBRIC_VERSION,
              at: DateTime.formatIso(yield* DateTime.now),
              status,
              reason,
              verdict,
              promptChars: evidence?.metrics.promptChars ?? 0,
              evidenceChars: evidence?.metrics.evidenceChars ?? 0,
            };
            yield* sql`INSERT INTO model_evaluations (run_id, project_id, thread_id, evaluated_at, source_sequence, source_message_ids, payload_json)
          VALUES (${runId}, ${projectId}, ${threadId}, ${record.at}, ${source.sourceSequence}, ${encodeIds(evidence?.sourceMessageIds ?? [])}, ${encodeRecord(record)})
          ON CONFLICT (run_id) DO NOTHING`;
          }),
        ),
      );
    },
    (effect, { runId }) =>
      effect.pipe(
        generationLock.withPermits(1),
        Effect.mapError((cause) => new ModelEvaluationPassError({ runId, cause })),
      ),
  );
  return ModelEvaluations.of({ enqueueRun, evaluateRun, list, clear, guidance });
});

export const layer = Layer.effect(ModelEvaluations, make);
