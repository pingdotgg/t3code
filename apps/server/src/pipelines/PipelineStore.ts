import {
  CheckpointRef,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  PIPELINE_OUTPUT_PREVIEW_CHARS,
  PipelineDefinition,
  PipelineError,
  PipelineRevision,
  PipelineRun,
  PipelineRunStep,
  PipelineSnapshot,
  type PipelineId,
  type PipelinePauseReason,
  type PipelineRunId,
  type PipelineRunStatus,
  type PipelineRunStepStatus,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** A run before its steps are attached; steps are inserted separately with it. */
export type NewPipelineRun = Omit<PipelineRun, "steps" | "revisions">;

/** Every step starts pending with attempt 0; only identity and the pause override are supplied. */
export type NewPipelineRunStep = Pick<PipelineRunStep, "index" | "stepId" | "pauseBefore">;

/** The workspace as the step's first attempt found it: a git checkpoint ref inside `cwd`. */
export const StartCheckpoint = Schema.Struct({ cwd: Schema.String, ref: CheckpointRef });
export type StartCheckpoint = typeof StartCheckpoint.Type;

export interface PipelineRunPatch {
  readonly updatedAt: string;
  readonly status?: PipelineRunStatus;
  readonly pauseReason?: PipelinePauseReason | null;
  readonly error?: string | null;
  readonly currentStepIndex?: number;
  readonly completedAt?: string | null;
  readonly definition?: PipelineSnapshot;
  readonly revisions?: ReadonlyArray<PipelineRevision>;
}

export interface PipelineStepPatch {
  readonly status?: PipelineRunStepStatus;
  readonly attempt?: number;
  readonly childThreadId?: ThreadId | null;
  readonly pauseBefore?: boolean;
  readonly prompt?: string | null;
  /** Where the attempt launches, saved with `prompt` so a restart relaunches the same step. */
  readonly workspaceStrategy?: OrchestrationV2ThreadLaunchWorkspaceStrategy | null;
  /** Kept across attempts: a restore-retry starts from the same snapshot. */
  readonly startCheckpoint?: StartCheckpoint | null;
  readonly output?: string | null;
  /** Whether `output` came from the agent's handoff rather than its thread's last message. */
  readonly handedOff?: boolean;
  readonly error?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  /**
   * A revision is waiting to reach the step. With a thread, the step continues in it and `prompt`
   * is the message to send there; without one it launches fresh with the feedback history.
   * Cleared whenever the step is launched, retried or taken over by hand.
   */
  readonly revising?: boolean;
}

export interface StepLaunch {
  readonly prompt: string;
  readonly workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy;
}

export class PipelineStore extends Context.Service<
  PipelineStore,
  {
    /** All definitions, oldest first; undecodable rows are logged and skipped. */
    readonly listDefinitions: () => Effect.Effect<ReadonlyArray<PipelineDefinition>, PipelineError>;
    /** One definition, or null when it does not exist; an undecodable row fails with PipelineError. */
    readonly getDefinition: (
      id: PipelineId,
    ) => Effect.Effect<PipelineDefinition | null, PipelineError>;
    /** Inserts a new definition; fails when the id already exists. */
    readonly insertDefinition: (
      definition: PipelineDefinition,
    ) => Effect.Effect<void, PipelineError>;
    /** Rewrites name, steps and updatedAt (never createdAt); false when the id does not exist. */
    readonly updateDefinition: (
      definition: PipelineDefinition,
    ) => Effect.Effect<boolean, PipelineError>;
    /** Deletes a definition without touching its runs; false when the id does not exist. */
    readonly deleteDefinition: (id: PipelineId) => Effect.Effect<boolean, PipelineError>;
    /**
     * Inserts a shipped starter and records its seed in one transaction, unless the key was
     * seeded before (even if the user since deleted it). An existing row with the starter's id
     * is kept and only the seed is recorded. Returns whether a definition was inserted.
     */
    readonly seedStarter: (input: {
      readonly key: string;
      readonly definition: PipelineDefinition;
    }) => Effect.Effect<boolean, PipelineError>;
    /** Inserts the run and one pending step per entry in a single transaction. */
    readonly insertRunWithSteps: (
      run: NewPipelineRun,
      steps: ReadonlyArray<NewPipelineRunStep>,
    ) => Effect.Effect<void, PipelineError>;
    /** The run with steps (output previews truncated), or null; a corrupt run fails with PipelineError. */
    readonly getRun: (runId: PipelineRunId) => Effect.Effect<PipelineRun | null, PipelineError>;
    /** Same as getRun, looked up by the run's parent thread. */
    readonly getRunByParentThreadId: (
      threadId: ThreadId,
    ) => Effect.Effect<PipelineRun | null, PipelineError>;
    /** Ids of runs in any of the given statuses, oldest first. */
    readonly listRunIdsByStatus: (
      statuses: ReadonlyArray<PipelineRunStatus>,
    ) => Effect.Effect<ReadonlyArray<PipelineRunId>, PipelineError>;
    /** Writes only the supplied run columns; a missing run is a no-op. */
    readonly updateRun: (
      runId: PipelineRunId,
      patch: PipelineRunPatch,
    ) => Effect.Effect<void, PipelineError>;
    /** Writes only the supplied step columns; a missing step is a no-op. */
    readonly updateStep: (
      runId: PipelineRunId,
      stepIndex: number,
      patch: PipelineStepPatch,
    ) => Effect.Effect<void, PipelineError>;
    /** Applies a run patch and step patches in one transaction. */
    readonly updateRunWithSteps: (
      runId: PipelineRunId,
      run: PipelineRunPatch,
      steps: ReadonlyArray<{ readonly index: number; readonly patch: PipelineStepPatch }>,
    ) => Effect.Effect<void, PipelineError>;
    /** The prompt and workspace saved when the step's latest attempt started; null when absent. */
    readonly getStepLaunch: (
      runId: PipelineRunId,
      stepIndex: number,
    ) => Effect.Effect<StepLaunch | null, PipelineError>;
    /** Whether a revision is waiting to reach the step (see `PipelineStepPatch.revising`). */
    readonly isStepRevising: (
      runId: PipelineRunId,
      stepIndex: number,
    ) => Effect.Effect<boolean, PipelineError>;
    /** The step's saved starting snapshot, or null when none was recorded. */
    readonly getStepStartCheckpoint: (
      runId: PipelineRunId,
      stepIndex: number,
    ) => Effect.Effect<StartCheckpoint | null, PipelineError>;
    /** Full (untruncated) captured output per step index; steps without output are absent. */
    readonly getStepOutputs: (
      runId: PipelineRunId,
    ) => Effect.Effect<ReadonlyMap<number, string>, PipelineError>;
  }
>()("t3/pipelines/PipelineStore") {}

interface PipelineRow {
  readonly pipeline_id: string;
  readonly name: string;
  readonly steps_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface PipelineRunRow {
  readonly run_id: string;
  readonly pipeline_id: string | null;
  readonly definition_json: string;
  readonly project_id: string;
  readonly parent_thread_id: string;
  readonly input: string;
  readonly workspace_strategy_json: string;
  readonly status: string;
  readonly pause_reason: string | null;
  readonly error: string | null;
  readonly current_step_index: number;
  readonly created_by: string;
  readonly creation_source: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
  readonly revisions_json: string;
}

interface PipelineRunStepRow {
  readonly step_index: number;
  readonly step_id: string;
  readonly status: string;
  readonly attempt: number;
  readonly child_thread_id: string | null;
  readonly pause_before: number;
  readonly has_start_checkpoint: number;
  readonly handed_off: number;
  readonly output: string | null;
  readonly error: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

const decodeDefinition = Schema.decodeUnknownEffect(PipelineDefinition);
const decodeRun = Schema.decodeUnknownEffect(PipelineRun);
const encodeStepsJson = Schema.encodeSync(Schema.fromJsonString(PipelineDefinition.fields.steps));
const encodeRevisionsJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(PipelineRevision)),
);
const encodeSnapshotJson = Schema.encodeSync(Schema.fromJsonString(PipelineSnapshot));
const workspaceStrategyJson = Schema.fromJsonString(OrchestrationV2ThreadLaunchWorkspaceStrategy);
const encodeWorkspaceStrategyJson = Schema.encodeSync(workspaceStrategyJson);
const decodeWorkspaceStrategyJson = Schema.decodeUnknownEffect(workspaceStrategyJson);
const startCheckpointJson = Schema.fromJsonString(StartCheckpoint);
const encodeStartCheckpointJson = Schema.encodeSync(startCheckpointJson);
const decodeStartCheckpointJson = Schema.decodeUnknownEffect(startCheckpointJson);
const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Truncates to the preview limit without splitting a surrogate pair. */
export function pipelineOutputPreview(output: string | null): string | null {
  if (output === null || output.length <= PIPELINE_OUTPUT_PREVIEW_CHARS) return output;
  const end = output.charCodeAt(PIPELINE_OUTPUT_PREVIEW_CHARS - 1);
  const cut =
    end >= 0xd800 && end <= 0xdbff
      ? PIPELINE_OUTPUT_PREVIEW_CHARS - 1
      : PIPELINE_OUTPUT_PREVIEW_CHARS;
  return output.slice(0, cut);
}

const storageError = (message: string, ids: { runId?: PipelineRunId; pipelineId?: PipelineId }) =>
  Effect.mapError(
    (cause: unknown) =>
      new PipelineError({
        message,
        ...(ids.runId === undefined ? {} : { runId: ids.runId }),
        ...(ids.pipelineId === undefined ? {} : { pipelineId: ids.pipelineId }),
        cause,
      }),
  );

const decodeDefinitionRow = Effect.fnUntraced(function* (row: PipelineRow) {
  const steps = yield* parseJson(row.steps_json);
  return yield* decodeDefinition({
    id: row.pipeline_id,
    name: row.name,
    steps,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

const decodeRunRow = Effect.fnUntraced(function* (
  row: PipelineRunRow,
  stepRows: ReadonlyArray<PipelineRunStepRow>,
) {
  const definition = yield* parseJson(row.definition_json);
  const workspaceStrategy = yield* parseJson(row.workspace_strategy_json);
  const revisions = yield* parseJson(row.revisions_json);
  return yield* decodeRun({
    id: row.run_id,
    pipelineId: row.pipeline_id,
    definition,
    projectId: row.project_id,
    parentThreadId: row.parent_thread_id,
    input: row.input,
    workspaceStrategy,
    status: row.status,
    pauseReason: row.pause_reason,
    error: row.error,
    currentStepIndex: row.current_step_index,
    revisions,
    steps: stepRows.map((step) => ({
      index: step.step_index,
      stepId: step.step_id,
      status: step.status,
      attempt: step.attempt,
      childThreadId: step.child_thread_id,
      pauseBefore: step.pause_before === 1,
      canRestoreWorkspace: step.has_start_checkpoint === 1,
      outputPreview: pipelineOutputPreview(step.output),
      handedOff: step.handed_off === 1,
      error: step.error,
      startedAt: step.started_at,
      completedAt: step.completed_at,
    })),
    createdBy: row.created_by,
    creationSource: row.creation_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  });
});

const definedColumns = (columns: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));

const runColumns = (patch: PipelineRunPatch) =>
  definedColumns({
    status: patch.status,
    pause_reason: patch.pauseReason,
    error: patch.error,
    current_step_index: patch.currentStepIndex,
    updated_at: patch.updatedAt,
    completed_at: patch.completedAt,
    definition_json:
      patch.definition === undefined ? undefined : encodeSnapshotJson(patch.definition),
    revisions_json:
      patch.revisions === undefined ? undefined : encodeRevisionsJson(patch.revisions),
  });

const stepColumns = (patch: PipelineStepPatch) =>
  definedColumns({
    status: patch.status,
    attempt: patch.attempt,
    child_thread_id: patch.childThreadId,
    pause_before: patch.pauseBefore === undefined ? undefined : patch.pauseBefore ? 1 : 0,
    prompt: patch.prompt,
    workspace_strategy_json:
      patch.workspaceStrategy === undefined || patch.workspaceStrategy === null
        ? patch.workspaceStrategy
        : encodeWorkspaceStrategyJson(patch.workspaceStrategy),
    start_checkpoint_json:
      patch.startCheckpoint === undefined || patch.startCheckpoint === null
        ? patch.startCheckpoint
        : encodeStartCheckpointJson(patch.startCheckpoint),
    output: patch.output,
    handed_off: patch.handedOff === undefined ? undefined : patch.handedOff ? 1 : 0,
    error: patch.error,
    started_at: patch.startedAt,
    completed_at: patch.completedAt,
    revising: patch.revising === undefined ? undefined : patch.revising ? 1 : 0,
  });

export const layer: Layer.Layer<PipelineStore, never, SqlClient.SqlClient> = Layer.effect(
  PipelineStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const listDefinitions: PipelineStore["Service"]["listDefinitions"] = Effect.fn(
      "PipelineStore.listDefinitions",
    )(function* () {
      const rows = yield* sql<PipelineRow>`
        SELECT * FROM pipelines ORDER BY created_at ASC, pipeline_id ASC
      `.pipe(NodeSqliteClient.readOnly, storageError("Could not read pipelines.", {}));
      const definitions: PipelineDefinition[] = [];
      for (const row of rows) {
        const decoded = yield* Effect.result(decodeDefinitionRow(row));
        if (Result.isSuccess(decoded)) {
          definitions.push(decoded.success);
        } else {
          yield* Effect.logWarning("Skipping undecodable pipeline row", {
            pipelineId: row.pipeline_id,
            cause: decoded.failure,
          });
        }
      }
      return definitions;
    });

    const getDefinition: PipelineStore["Service"]["getDefinition"] = Effect.fn(
      "PipelineStore.getDefinition",
    )(function* (id) {
      const rows = yield* sql<PipelineRow>`
        SELECT * FROM pipelines WHERE pipeline_id = ${id}
      `.pipe(
        NodeSqliteClient.readOnly,
        storageError("Could not read pipeline.", { pipelineId: id }),
      );
      const row = rows[0];
      if (row === undefined) return null;
      return yield* decodeDefinitionRow(row).pipe(
        storageError("Could not decode pipeline row.", { pipelineId: id }),
      );
    });

    const insertDefinition: PipelineStore["Service"]["insertDefinition"] = Effect.fn(
      "PipelineStore.insertDefinition",
    )(function* (definition) {
      yield* sql`
        INSERT INTO pipelines (pipeline_id, name, steps_json, created_at, updated_at)
        VALUES (
          ${definition.id},
          ${definition.name},
          ${encodeStepsJson(definition.steps)},
          ${definition.createdAt},
          ${definition.updatedAt}
        )
      `.pipe(storageError("Could not save pipeline.", { pipelineId: definition.id }));
    });

    const updateDefinition: PipelineStore["Service"]["updateDefinition"] = Effect.fn(
      "PipelineStore.updateDefinition",
    )(function* (definition) {
      const rows = yield* sql<{ readonly pipeline_id: string }>`
        UPDATE pipelines
        SET name = ${definition.name},
            steps_json = ${encodeStepsJson(definition.steps)},
            updated_at = ${definition.updatedAt}
        WHERE pipeline_id = ${definition.id}
        RETURNING pipeline_id
      `.pipe(storageError("Could not save pipeline.", { pipelineId: definition.id }));
      return rows.length > 0;
    });

    const deleteDefinition: PipelineStore["Service"]["deleteDefinition"] = Effect.fn(
      "PipelineStore.deleteDefinition",
    )(function* (id) {
      const rows = yield* sql<{ readonly pipeline_id: string }>`
        DELETE FROM pipelines WHERE pipeline_id = ${id} RETURNING pipeline_id
      `.pipe(storageError("Could not delete pipeline.", { pipelineId: id }));
      return rows.length > 0;
    });

    const seedStarter: PipelineStore["Service"]["seedStarter"] = Effect.fn(
      "PipelineStore.seedStarter",
    )(function* ({ key, definition }) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const seeds = yield* sql<{ readonly starter_key: string }>`
                SELECT starter_key FROM pipeline_starter_seeds WHERE starter_key = ${key}
              `;
            if (seeds.length > 0) return false;
            const inserted = yield* sql<{ readonly pipeline_id: string }>`
                INSERT INTO pipelines (pipeline_id, name, steps_json, created_at, updated_at)
                VALUES (
                  ${definition.id},
                  ${definition.name},
                  ${encodeStepsJson(definition.steps)},
                  ${definition.createdAt},
                  ${definition.updatedAt}
                )
                ON CONFLICT (pipeline_id) DO NOTHING
                RETURNING pipeline_id
              `;
            yield* sql`
                INSERT INTO pipeline_starter_seeds (starter_key, pipeline_id, seeded_at)
                VALUES (${key}, ${definition.id}, ${definition.createdAt})
              `;
            return inserted.length > 0;
          }),
        )
        .pipe(storageError("Could not seed starter pipeline.", { pipelineId: definition.id }));
    });

    const insertRunWithSteps: PipelineStore["Service"]["insertRunWithSteps"] = Effect.fn(
      "PipelineStore.insertRunWithSteps",
    )(function* (run, steps) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO pipeline_runs ${sql.insert({
                run_id: run.id,
                pipeline_id: run.pipelineId,
                definition_json: encodeSnapshotJson(run.definition),
                project_id: run.projectId,
                parent_thread_id: run.parentThreadId,
                input: run.input,
                workspace_strategy_json: encodeWorkspaceStrategyJson(run.workspaceStrategy),
                status: run.status,
                pause_reason: run.pauseReason,
                error: run.error,
                current_step_index: run.currentStepIndex,
                created_by: run.createdBy,
                creation_source: run.creationSource,
                created_at: run.createdAt,
                updated_at: run.updatedAt,
                completed_at: run.completedAt,
              })}
            `;
            if (steps.length === 0) return;
            yield* sql`
              INSERT INTO pipeline_run_steps ${sql.insert(
                steps.map((step) => ({
                  run_id: run.id,
                  step_index: step.index,
                  step_id: step.stepId,
                  status: "pending",
                  attempt: 0,
                  child_thread_id: null,
                  pause_before: step.pauseBefore ? 1 : 0,
                  prompt: null,
                  workspace_strategy_json: null,
                  start_checkpoint_json: null,
                  output: null,
                  handed_off: 0,
                  error: null,
                  started_at: null,
                  completed_at: null,
                })),
              )}
            `;
          }),
        )
        .pipe(storageError("Could not save pipeline run.", { runId: run.id }));
    });

    const readRun = Effect.fn("PipelineStore.readRun")(function* (
      column: "run_id" | "parent_thread_id",
      value: string,
    ) {
      const read = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<PipelineRunRow>`
                SELECT * FROM pipeline_runs WHERE ${sql(column)} = ${value}
              `;
            const row = rows[0];
            if (row === undefined) return null;
            const stepRows = yield* sql<PipelineRunStepRow>`
                SELECT step_index, step_id, status, attempt, child_thread_id, pause_before,
                       start_checkpoint_json IS NOT NULL AS has_start_checkpoint,
                       handed_off, output, error, started_at, completed_at
                FROM pipeline_run_steps
                WHERE run_id = ${row.run_id}
                ORDER BY step_index ASC
              `;
            return { row, stepRows };
          }),
        )
        .pipe(NodeSqliteClient.readOnly, storageError("Could not read pipeline run.", {}));
      if (read === null) return null;
      return yield* decodeRunRow(read.row, read.stepRows).pipe(
        storageError("Could not decode pipeline run.", {
          runId: read.row.run_id as PipelineRunId,
        }),
      );
    });

    const getRun: PipelineStore["Service"]["getRun"] = Effect.fn("PipelineStore.getRun")(
      function* (runId) {
        return yield* readRun("run_id", runId);
      },
    );

    const getRunByParentThreadId: PipelineStore["Service"]["getRunByParentThreadId"] = Effect.fn(
      "PipelineStore.getRunByParentThreadId",
    )(function* (threadId) {
      return yield* readRun("parent_thread_id", threadId);
    });

    const listRunIdsByStatus: PipelineStore["Service"]["listRunIdsByStatus"] = Effect.fn(
      "PipelineStore.listRunIdsByStatus",
    )(function* (statuses) {
      if (statuses.length === 0) return [];
      const rows = yield* sql<{ readonly run_id: PipelineRunId }>`
        SELECT run_id FROM pipeline_runs
        WHERE status IN ${sql.in(statuses)}
        ORDER BY created_at ASC, run_id ASC
      `.pipe(NodeSqliteClient.readOnly, storageError("Could not list pipeline runs.", {}));
      return rows.map((row) => row.run_id);
    });

    const writeRun = (runId: PipelineRunId, patch: PipelineRunPatch) =>
      sql`UPDATE pipeline_runs SET ${sql.update(runColumns(patch))} WHERE run_id = ${runId}`;

    const writeStep = (runId: PipelineRunId, stepIndex: number, patch: PipelineStepPatch) => {
      const columns = stepColumns(patch);
      if (Object.keys(columns).length === 0) return Effect.void;
      return sql`
        UPDATE pipeline_run_steps SET ${sql.update(columns)}
        WHERE run_id = ${runId} AND step_index = ${stepIndex}
      `;
    };

    const updateRun: PipelineStore["Service"]["updateRun"] = Effect.fn("PipelineStore.updateRun")(
      function* (runId, patch) {
        yield* writeRun(runId, patch).pipe(
          storageError("Could not update pipeline run.", { runId }),
        );
      },
    );

    const updateStep: PipelineStore["Service"]["updateStep"] = Effect.fn(
      "PipelineStore.updateStep",
    )(function* (runId, stepIndex, patch) {
      yield* writeStep(runId, stepIndex, patch).pipe(
        storageError("Could not update pipeline step.", { runId }),
      );
    });

    const updateRunWithSteps: PipelineStore["Service"]["updateRunWithSteps"] = Effect.fn(
      "PipelineStore.updateRunWithSteps",
    )(function* (runId, run, steps) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            for (const { index, patch } of steps) yield* writeStep(runId, index, patch);
            yield* writeRun(runId, run);
          }),
        )
        .pipe(storageError("Could not update pipeline run.", { runId }));
    });

    const getStepLaunch: PipelineStore["Service"]["getStepLaunch"] = Effect.fn(
      "PipelineStore.getStepLaunch",
    )(function* (runId, stepIndex) {
      const rows = yield* sql<{
        readonly prompt: string | null;
        readonly workspace_strategy_json: string | null;
      }>`
        SELECT prompt, workspace_strategy_json FROM pipeline_run_steps
        WHERE run_id = ${runId} AND step_index = ${stepIndex}
      `.pipe(NodeSqliteClient.readOnly, storageError("Could not read step launch.", { runId }));
      const row = rows[0];
      if (row === undefined || row.prompt === null || row.workspace_strategy_json === null) {
        return null;
      }
      const workspaceStrategy = yield* decodeWorkspaceStrategyJson(
        row.workspace_strategy_json,
      ).pipe(storageError("Could not decode step launch.", { runId }));
      return { prompt: row.prompt, workspaceStrategy };
    });

    const isStepRevising: PipelineStore["Service"]["isStepRevising"] = Effect.fn(
      "PipelineStore.isStepRevising",
    )(function* (runId, stepIndex) {
      const rows = yield* sql<{ readonly revising: number }>`
        SELECT revising FROM pipeline_run_steps
        WHERE run_id = ${runId} AND step_index = ${stepIndex}
      `.pipe(NodeSqliteClient.readOnly, storageError("Could not read step revising.", { runId }));
      return rows[0]?.revising === 1;
    });

    const getStepStartCheckpoint: PipelineStore["Service"]["getStepStartCheckpoint"] = Effect.fn(
      "PipelineStore.getStepStartCheckpoint",
    )(function* (runId, stepIndex) {
      const rows = yield* sql<{ readonly start_checkpoint_json: string | null }>`
        SELECT start_checkpoint_json FROM pipeline_run_steps
        WHERE run_id = ${runId} AND step_index = ${stepIndex}
      `.pipe(
        NodeSqliteClient.readOnly,
        storageError("Could not read step start checkpoint.", { runId }),
      );
      const json = rows[0]?.start_checkpoint_json;
      if (json === undefined || json === null) return null;
      return yield* decodeStartCheckpointJson(json).pipe(
        storageError("Could not decode step start checkpoint.", { runId }),
      );
    });

    const getStepOutputs: PipelineStore["Service"]["getStepOutputs"] = Effect.fn(
      "PipelineStore.getStepOutputs",
    )(function* (runId) {
      const rows = yield* sql<{ readonly step_index: number; readonly output: string }>`
        SELECT step_index, output FROM pipeline_run_steps
        WHERE run_id = ${runId} AND output IS NOT NULL
      `.pipe(NodeSqliteClient.readOnly, storageError("Could not read step output.", { runId }));
      return new Map(rows.map((row) => [row.step_index, row.output] as const));
    });

    return PipelineStore.of({
      listDefinitions,
      getDefinition,
      insertDefinition,
      updateDefinition,
      deleteDefinition,
      seedStarter,
      insertRunWithSteps,
      getRun,
      getRunByParentThreadId,
      listRunIdsByStatus,
      updateRun,
      updateStep,
      updateRunWithSteps,
      getStepLaunch,
      isStepRevising,
      getStepStartCheckpoint,
      getStepOutputs,
    });
  }),
);
