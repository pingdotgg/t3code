// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Script fixtures target an isolated local SQLite database.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

type SqlValue = string | number | null;

export interface ProjectionProjectFixtureRow {
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelectionJson: string;
  readonly scriptsJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string | null;
}

export interface ProjectionThreadFixtureRow {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly modelSelectionJson: string;
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly latestTurnId?: string | null;
  readonly latestUserMessageAt?: string | null;
  readonly pendingApprovalCount?: number;
  readonly pendingUserInputCount?: number;
  readonly hasActionableProposedPlan?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string | null;
  readonly deletedAt?: string | null;
  readonly settledOverride?: string | null;
  readonly settledAt?: string | null;
  readonly snoozedUntil?: string | null;
  readonly snoozedAt?: string | null;
}

export interface ProjectionTurnFixtureRow {
  readonly threadId: string;
  readonly turnId: string;
  readonly pendingMessageId?: string | null;
  readonly assistantMessageId?: string | null;
  readonly state: string;
  readonly requestedAt: string;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly checkpointTurnCount?: number | null;
  readonly checkpointRef?: string | null;
  readonly checkpointStatus?: string | null;
  readonly checkpointFilesJson?: string;
  readonly sourceProposedPlanThreadId?: string | null;
  readonly sourceProposedPlanId?: string | null;
}

export interface ProjectionMessageFixtureRow {
  readonly messageId: string;
  readonly threadId: string;
  readonly turnId?: string | null;
  readonly role: string;
  readonly text: string;
  readonly isStreaming?: number;
  readonly attachmentsJson?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectionActivityFixtureRow {
  readonly activityId: string;
  readonly threadId: string;
  readonly turnId?: string | null;
  readonly tone: string;
  readonly kind: string;
  readonly summary: string;
  readonly payloadJson: string;
  readonly sequence?: number | null;
  readonly createdAt: string;
}

export interface ProjectionSessionFixtureRow {
  readonly threadId: string;
  readonly status: string;
  readonly providerName?: string | null;
  readonly providerInstanceId?: string | null;
  readonly providerSessionId?: string | null;
  readonly providerThreadId?: string | null;
  readonly runtimeMode: string;
  readonly activeTurnId?: string | null;
  readonly lastError?: string | null;
  readonly updatedAt: string;
}

export interface ProjectionPendingApprovalFixtureRow {
  readonly requestId: string;
  readonly threadId: string;
  readonly turnId?: string | null;
  readonly status: string;
  readonly decision?: string | null;
  readonly createdAt: string;
  readonly resolvedAt?: string | null;
}

export interface ProjectionProposedPlanFixtureRow {
  readonly planId: string;
  readonly threadId: string;
  readonly turnId?: string | null;
  readonly planMarkdown: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly implementedAt?: string | null;
  readonly implementationThreadId?: string | null;
}

export interface ProjectionStateFixtureRow {
  readonly projector: string;
  readonly lastAppliedSequence: number;
  readonly updatedAt: string;
}

export interface ProjectionFixture {
  readonly projects: ReadonlyArray<ProjectionProjectFixtureRow>;
  readonly threads: ReadonlyArray<ProjectionThreadFixtureRow>;
  readonly turns: ReadonlyArray<ProjectionTurnFixtureRow>;
  readonly messages: ReadonlyArray<ProjectionMessageFixtureRow>;
  readonly activities?: ReadonlyArray<ProjectionActivityFixtureRow>;
  readonly sessions?: ReadonlyArray<ProjectionSessionFixtureRow>;
  readonly pendingApprovals?: ReadonlyArray<ProjectionPendingApprovalFixtureRow>;
  readonly proposedPlans?: ReadonlyArray<ProjectionProposedPlanFixtureRow>;
  readonly state?: ReadonlyArray<ProjectionStateFixtureRow>;
}

const TABLE_COLUMNS = {
  projection_projects: [
    "project_id",
    "title",
    "workspace_root",
    "default_model_selection_json",
    "scripts_json",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  projection_threads: [
    "thread_id",
    "project_id",
    "title",
    "model_selection_json",
    "runtime_mode",
    "interaction_mode",
    "branch",
    "worktree_path",
    "latest_turn_id",
    "latest_user_message_at",
    "pending_approval_count",
    "pending_user_input_count",
    "has_actionable_proposed_plan",
    "created_at",
    "updated_at",
    "archived_at",
    "deleted_at",
    "settled_override",
    "settled_at",
    "snoozed_until",
    "snoozed_at",
  ],
  projection_turns: [
    "thread_id",
    "turn_id",
    "pending_message_id",
    "assistant_message_id",
    "state",
    "requested_at",
    "started_at",
    "completed_at",
    "checkpoint_turn_count",
    "checkpoint_ref",
    "checkpoint_status",
    "checkpoint_files_json",
    "source_proposed_plan_thread_id",
    "source_proposed_plan_id",
  ],
  projection_thread_messages: [
    "message_id",
    "thread_id",
    "turn_id",
    "role",
    "text",
    "is_streaming",
    "attachments_json",
    "created_at",
    "updated_at",
  ],
  projection_thread_activities: [
    "activity_id",
    "thread_id",
    "turn_id",
    "tone",
    "kind",
    "summary",
    "payload_json",
    "sequence",
    "created_at",
  ],
  projection_thread_sessions: [
    "thread_id",
    "status",
    "provider_name",
    "provider_instance_id",
    "provider_session_id",
    "provider_thread_id",
    "runtime_mode",
    "active_turn_id",
    "last_error",
    "updated_at",
  ],
  projection_pending_approvals: [
    "request_id",
    "thread_id",
    "turn_id",
    "status",
    "decision",
    "created_at",
    "resolved_at",
  ],
  projection_thread_proposed_plans: [
    "plan_id",
    "thread_id",
    "turn_id",
    "plan_markdown",
    "created_at",
    "updated_at",
    "implemented_at",
    "implementation_thread_id",
  ],
  projection_state: ["projector", "last_applied_sequence", "updated_at"],
} as const;

export const SEEDED_PROJECTION_TABLES = [
  "projection_pending_approvals",
  "projection_thread_proposed_plans",
  "projection_thread_activities",
  "projection_thread_messages",
  "projection_thread_sessions",
  "projection_turns",
  "projection_threads",
  "projection_projects",
  "projection_state",
] as const;

function values(...values: ReadonlyArray<SqlValue | undefined>): Array<SqlValue> {
  return values.map((value) => value ?? null);
}

function insertRows(
  database: NodeSqlite.DatabaseSync,
  table: keyof typeof TABLE_COLUMNS,
  rows: ReadonlyArray<ReadonlyArray<SqlValue>>,
): void {
  if (rows.length === 0) return;
  const columns = TABLE_COLUMNS[table];
  const statement = database.prepare(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  for (const row of rows) statement.run(...row);
}

function schemaProblem(database: NodeSqlite.DatabaseSync): string | undefined {
  for (const [table, expectedColumns] of Object.entries(TABLE_COLUMNS)) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      readonly name: string;
    }>;
    if (columns.length === 0) return `missing table ${table}`;
    const available = new Set(columns.map((column) => column.name));
    const missing = expectedColumns.filter((column) => !available.has(column));
    if (missing.length > 0) return `${table} is missing columns: ${missing.join(", ")}`;
  }
  return undefined;
}

export function hasProjectionFixtureSchema(dbPath: string): boolean {
  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return false;
  }
  try {
    return schemaProblem(database) === undefined;
  } catch {
    return false;
  } finally {
    database.close();
  }
}

export async function waitForProjectionFixtureSchema(
  dbPath: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasProjectionFixtureSchema(dbPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The environment server did not migrate ${dbPath} within ${timeoutMs}ms.`);
}

function isWithin(root: string, target: string): boolean {
  const relative = NodePath.relative(NodePath.resolve(root), NodePath.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

export function assertDisposableProjectionTarget(input: {
  readonly dbPath: string;
  readonly disposableRoot: string;
  readonly liveHomeDir?: string | undefined;
}): void {
  if (!isWithin(input.disposableRoot, input.dbPath)) {
    throw new Error(
      `Projection fixture database must be inside disposable root ${input.disposableRoot}.`,
    );
  }
  // T3CODE_HOME is frequently unset — the desktop app falls back to ~/.t3 on
  // its own — so guarding only the environment variable left the default
  // install unprotected. Both are checked.
  for (const liveHome of [
    input.liveHomeDir,
    process.env.T3CODE_HOME,
    NodePath.join(NodeOS.homedir(), ".t3"),
  ]) {
    if (liveHome && isWithin(liveHome, input.dbPath)) {
      throw new Error(`Refusing to write a projection fixture inside live T3 home ${liveHome}.`);
    }
  }
}

export function writeProjectionFixture(input: {
  readonly dbPath: string;
  readonly disposableRoot: string;
  readonly fixture: ProjectionFixture;
  readonly liveHomeDir?: string | undefined;
  readonly busyTimeoutMs?: number;
  /** Test/integration seam for callers that already own a SQLite handle. */
  readonly database?: NodeSqlite.DatabaseSync;
}): void {
  assertDisposableProjectionTarget(input);
  const ownsDatabase = input.database === undefined;
  const database =
    input.database ??
    new NodeSqlite.DatabaseSync(input.dbPath, { timeout: input.busyTimeoutMs ?? 30_000 });
  try {
    const problem = schemaProblem(database);
    if (problem) throw new Error(`Projection fixture schema is not ready: ${problem}.`);
    if (database.isTransaction) {
      throw new Error("Projection fixture writer requires transaction ownership.");
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const table of SEEDED_PROJECTION_TABLES) database.exec(`DELETE FROM ${table}`);
      insertRows(
        database,
        "projection_projects",
        input.fixture.projects.map((row) =>
          values(
            row.projectId,
            row.title,
            row.workspaceRoot,
            row.defaultModelSelectionJson,
            row.scriptsJson,
            row.createdAt,
            row.updatedAt,
            row.deletedAt,
          ),
        ),
      );
      insertRows(
        database,
        "projection_threads",
        input.fixture.threads.map((row) =>
          values(
            row.threadId,
            row.projectId,
            row.title,
            row.modelSelectionJson,
            row.runtimeMode,
            row.interactionMode,
            row.branch,
            row.worktreePath,
            row.latestTurnId,
            row.latestUserMessageAt,
            row.pendingApprovalCount ?? 0,
            row.pendingUserInputCount ?? 0,
            row.hasActionableProposedPlan ?? 0,
            row.createdAt,
            row.updatedAt,
            row.archivedAt,
            row.deletedAt,
            row.settledOverride,
            row.settledAt,
            row.snoozedUntil,
            row.snoozedAt,
          ),
        ),
      );
      insertRows(
        database,
        "projection_turns",
        input.fixture.turns.map((row) =>
          values(
            row.threadId,
            row.turnId,
            row.pendingMessageId,
            row.assistantMessageId,
            row.state,
            row.requestedAt,
            row.startedAt,
            row.completedAt,
            row.checkpointTurnCount,
            row.checkpointRef,
            row.checkpointStatus,
            row.checkpointFilesJson ?? "[]",
            row.sourceProposedPlanThreadId,
            row.sourceProposedPlanId,
          ),
        ),
      );
      insertRows(
        database,
        "projection_thread_messages",
        input.fixture.messages.map((row) =>
          values(
            row.messageId,
            row.threadId,
            row.turnId,
            row.role,
            row.text,
            row.isStreaming ?? 0,
            row.attachmentsJson,
            row.createdAt,
            row.updatedAt,
          ),
        ),
      );
      insertRows(
        database,
        "projection_thread_activities",
        (input.fixture.activities ?? []).map((row) =>
          values(
            row.activityId,
            row.threadId,
            row.turnId,
            row.tone,
            row.kind,
            row.summary,
            row.payloadJson,
            row.sequence,
            row.createdAt,
          ),
        ),
      );
      insertRows(
        database,
        "projection_thread_sessions",
        (input.fixture.sessions ?? []).map((row) =>
          values(
            row.threadId,
            row.status,
            row.providerName,
            row.providerInstanceId,
            row.providerSessionId,
            row.providerThreadId,
            row.runtimeMode,
            row.activeTurnId,
            row.lastError,
            row.updatedAt,
          ),
        ),
      );
      insertRows(
        database,
        "projection_pending_approvals",
        (input.fixture.pendingApprovals ?? []).map((row) =>
          values(
            row.requestId,
            row.threadId,
            row.turnId,
            row.status,
            row.decision,
            row.createdAt,
            row.resolvedAt,
          ),
        ),
      );
      insertRows(
        database,
        "projection_thread_proposed_plans",
        (input.fixture.proposedPlans ?? []).map((row) =>
          values(
            row.planId,
            row.threadId,
            row.turnId,
            row.planMarkdown,
            row.createdAt,
            row.updatedAt,
            row.implementedAt,
            row.implementationThreadId,
          ),
        ),
      );
      insertRows(
        database,
        "projection_state",
        (input.fixture.state ?? []).map((row) =>
          values(row.projector, row.lastAppliedSequence, row.updatedAt),
        ),
      );
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    if (ownsDatabase) database.close();
  }
}
