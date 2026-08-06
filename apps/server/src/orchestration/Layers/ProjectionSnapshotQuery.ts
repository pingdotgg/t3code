import {
  ChatAttachment,
  EventId,
  IsoDateTime,
  MessageId,
  MessageOrigin,
  NonNegativeInt,
  OrchestrationCheckpointFile,
  OrchestrationProposedPlanId,
  OrchestrationReadModel,
  OrchestrationQueuedTurn,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  ProjectScript,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationBackgroundAgentRunShell,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlan,
  type OrchestrationProject,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  GitResolvedPullRequest,
  ModelSelection,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  ReviewResult,
  ReviewSnapshot,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { ProjectionCheckpoint } from "../../persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionState } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionQueuedTurn } from "../../persistence/Services/ProjectionQueuedTurns.ts";
import { ProjectionThreadSession } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionWorkflowRepository } from "../../persistence/Services/ProjectionWorkflows.ts";
import { ProjectionWorkflowRepositoryLive } from "../../persistence/Layers/ProjectionWorkflows.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotCounts,
  type ProjectionThreadCheckpointContext,
  type ProjectionThreadShellProjectContext,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const decodeShellSnapshot = Schema.decodeUnknownEffect(OrchestrationShellSnapshot);
const decodeThread = Schema.decodeUnknownEffect(OrchestrationThread);
const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  }),
);
const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
    origin: Schema.NullOr(Schema.fromJsonString(MessageOrigin)),
  }),
);
const ProjectionThreadProposedPlanDbRowSchema = ProjectionThreadProposedPlan;
const ProjectionQueuedTurnDbRowSchema = ProjectionQueuedTurn.mapFields(
  Struct.assign({
    attachments: Schema.fromJsonString(Schema.Array(ChatAttachment)),
    origin: Schema.NullOr(Schema.fromJsonString(MessageOrigin)),
    modelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
  }),
);
const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    pullRequest: Schema.fromJsonString(Schema.NullOr(GitResolvedPullRequest)),
    reviewSnapshot: Schema.fromJsonString(Schema.NullOr(ReviewSnapshot)),
    reviewResult: Schema.fromJsonString(Schema.NullOr(ReviewResult)),
  }),
);
const ProjectionThreadWithProjectTitleDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    pullRequest: Schema.fromJsonString(Schema.NullOr(GitResolvedPullRequest)),
    reviewSnapshot: Schema.fromJsonString(Schema.NullOr(ReviewSnapshot)),
    reviewResult: Schema.fromJsonString(Schema.NullOr(ReviewResult)),
    projectTitle: Schema.NullOr(TrimmedNonEmptyString),
  }),
);
const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
type ProjectionThreadActivityDbRow = typeof ProjectionThreadActivityDbRowSchema.Type;

function mapThreadActivityRow(row: ProjectionThreadActivityDbRow): OrchestrationThreadActivity {
  return {
    id: row.activityId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload,
    turnId: row.turnId,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    createdAt: row.createdAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deriveBackgroundAgentRunsByThread(
  rows: readonly ProjectionThreadActivityDbRow[],
): Map<string, OrchestrationBackgroundAgentRunShell[]> {
  const runsByThread = new Map<string, Map<string, OrchestrationBackgroundAgentRunShell>>();
  for (const row of rows) {
    if (!isRecord(row.payload)) continue;
    const taskId = typeof row.payload.taskId === "string" ? row.payload.taskId : undefined;
    if (!taskId) continue;
    const threadRuns = runsByThread.get(row.threadId) ?? new Map();
    if (row.kind === "task.started" && row.payload.taskType === "background-agent") {
      threadRuns.set(taskId, {
        taskId,
        name: typeof row.payload.name === "string" ? row.payload.name : row.summary,
        status: "running",
        startedAt: row.createdAt,
      });
      runsByThread.set(row.threadId, threadRuns);
      continue;
    }
    if (row.kind !== "task.completed") continue;
    const run = threadRuns.get(taskId);
    if (!run) continue;
    const status = row.payload.status;
    threadRuns.set(taskId, {
      ...run,
      status: status === "failed" || status === "stopped" ? status : "completed",
      completedAt: row.createdAt,
    });
  }
  return new Map(
    [...runsByThread].map(([threadId, runs]) => [threadId, [...runs.values()]] as const),
  );
}
const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession.mapFields(
  Struct.assign({
    resumeCursor: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  }),
);
const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
    agentTouchedPaths: Schema.fromJsonString(Schema.Array(TrimmedNonEmptyString)),
    turnFiles: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);
const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  turnId: TurnId,
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
});
const ProjectionTurnSnapshotBoundsRowSchema = Schema.Struct({
  snapshotMaxRequestedAt: Schema.NullOr(IsoDateTime),
  snapshotMaxStartedAt: Schema.NullOr(IsoDateTime),
  snapshotMaxCompletedAt: Schema.NullOr(IsoDateTime),
});
const ProjectionStateDbRowSchema = ProjectionState;
const ProjectionUpdatedAtBoundsRowSchema = Schema.Struct({
  maxProjectUpdatedAt: Schema.NullOr(IsoDateTime),
  maxThreadUpdatedAt: Schema.NullOr(IsoDateTime),
  maxThreadSessionUpdatedAt: Schema.NullOr(IsoDateTime),
});
const ProjectionCountsRowSchema = Schema.Struct({
  projectCount: Schema.Number,
  threadCount: Schema.Number,
});
const WorkspaceRootLookupInput = Schema.Struct({
  workspaceRoot: Schema.String,
});
const ProjectIdLookupInput = Schema.Struct({
  projectId: ProjectId,
});
const ThreadIdLookupInput = Schema.Struct({
  threadId: ThreadId,
});
const THREAD_DETAIL_ACTIVITY_WINDOW = 200;
const ThreadActivitiesLimitInput = Schema.Struct({
  threadId: ThreadId,
  limit: NonNegativeInt,
});
const ThreadActivitiesBeforeActivityInput = Schema.Struct({
  threadId: ThreadId,
  beforeCreatedAt: IsoDateTime,
  beforeActivityId: EventId,
  limit: NonNegativeInt,
});
const TurnActivitiesBeforeActivityInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  beforeCreatedAt: IsoDateTime,
  beforeActivityId: EventId,
  limit: NonNegativeInt,
});
const TurnActivityExistsBeforeActivityInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  beforeCreatedAt: IsoDateTime,
  beforeActivityId: EventId,
});
const TurnActivityExistsRowSchema = Schema.Struct({
  activityId: EventId,
});
const TranscriptSearchRowSchema = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  projectTitle: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  role: Schema.Literals(["user", "assistant"]),
  excerpt: Schema.String,
  updatedAt: IsoDateTime,
});
const ProjectionProjectLookupRowSchema = ProjectionProjectDbRowSchema;
const ProjectionThreadIdLookupRowSchema = Schema.Struct({
  threadId: ThreadId,
});
const ProjectionThreadCheckpointContextThreadRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
});

const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.projects,
  ORCHESTRATION_PROJECTOR_NAMES.threads,
  ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
  ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
  ORCHESTRATION_PROJECTOR_NAMES.queuedTurns,
  ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
  ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
  ORCHESTRATION_PROJECTOR_NAMES.workflows,
] as const;

function maxIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }
  return left > right ? left : right;
}

function computeSnapshotSequence(
  stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
): number {
  if (stateRows.length === 0) {
    return 0;
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  );

  let minSequence = Number.POSITIVE_INFINITY;
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
    const sequence = sequenceByProjector.get(projector);
    if (sequence === undefined) {
      return 0;
    }
    if (sequence < minSequence) {
      minSequence = sequence;
    }
  }

  return Number.isFinite(minSequence) ? minSequence : 0;
}

function mapLatestTurn(
  row: Schema.Schema.Type<typeof ProjectionLatestTurnDbRowSchema>,
): OrchestrationLatestTurn {
  return {
    turnId: row.turnId,
    state:
      row.state === "error"
        ? "error"
        : row.state === "interrupted"
          ? "interrupted"
          : row.state === "completed"
            ? "completed"
            : "running",
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    assistantMessageId: row.assistantMessageId,
    ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
      ? {
          sourceProposedPlan: {
            threadId: row.sourceProposedPlanThreadId,
            planId: row.sourceProposedPlanId,
          },
        }
      : {}),
  };
}

function mapSessionRow(
  row: Schema.Schema.Type<typeof ProjectionThreadSessionDbRowSchema>,
): OrchestrationSession {
  return {
    threadId: row.threadId,
    status: row.status,
    providerName: row.providerName,
    ...(row.providerInstanceId !== null ? { providerInstanceId: row.providerInstanceId } : {}),
    runtimeMode: row.runtimeMode,
    activeTurnId: row.activeTurnId,
    ...(row.resumeCursor !== null ? { resumeCursor: row.resumeCursor } : {}),
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}

function mapQueuedTurnRow(
  row: Schema.Schema.Type<typeof ProjectionQueuedTurnDbRowSchema>,
): OrchestrationQueuedTurn {
  return {
    id: row.queuedTurnId,
    threadId: row.threadId,
    message: {
      messageId: row.messageId,
      role: "user",
      text: row.text,
      attachments: row.attachments,
    },
    ...(row.origin !== null ? { origin: row.origin } : {}),
    ...(row.modelSelection !== null ? { modelSelection: row.modelSelection } : {}),
    ...(row.titleSeed !== null ? { titleSeed: row.titleSeed } : {}),
    runtimeMode: row.runtimeMode,
    interactionMode: row.interactionMode,
    ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
      ? {
          sourceProposedPlan: {
            threadId: row.sourceProposedPlanThreadId,
            planId: row.sourceProposedPlanId,
          },
        }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    failedAt: row.failedAt,
    failureMessage: row.failureMessage,
  };
}

function reconcileLatestTurnWithSession(
  latestTurn: OrchestrationLatestTurn | null,
  session: OrchestrationSession | null,
): OrchestrationLatestTurn | null {
  if (session?.status !== "running" || session.activeTurnId === null) {
    return latestTurn;
  }

  if (latestTurn?.turnId === session.activeTurnId) {
    return {
      ...latestTurn,
      state: "running",
      startedAt: latestTurn.startedAt ?? session.updatedAt,
      completedAt: null,
    };
  }

  return {
    turnId: session.activeTurnId,
    state: "running",
    requestedAt: session.updatedAt,
    startedAt: session.updatedAt,
    completedAt: null,
    assistantMessageId: null,
  };
}

function mapProjectShellRow(
  row: Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>,
  repositoryIdentity: OrchestrationProject["repositoryIdentity"],
): OrchestrationProjectShell {
  return {
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: row.defaultModelSelection,
    scripts: row.scripts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver;
  const projectionWorkflowRepository = yield* ProjectionWorkflowRepository;
  const repositoryIdentityResolutionConcurrency = 4;

  // Shared column lists so the full-snapshot and live-only variants below can
  // never drift apart when a projection column is added.
  const projectRowColumns = sql`
    project_id AS "projectId",
    title,
    workspace_root AS "workspaceRoot",
    default_model_selection_json AS "defaultModelSelection",
    scripts_json AS "scripts",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    deleted_at AS "deletedAt"
  `;

  const threadRowColumns = sql`
    thread_id AS "threadId",
    project_id AS "projectId",
    parent_thread_id AS "parentThreadId",
    title,
    model_selection_json AS "modelSelection",
    runtime_mode AS "runtimeMode",
    pending_runtime_mode AS "pendingRuntimeMode",
    interaction_mode AS "interactionMode",
    branch,
    worktree_path AS "worktreePath",
    pull_request_json AS "pullRequest",
    review_snapshot_json AS "reviewSnapshot",
    review_result_json AS "reviewResult",
    latest_turn_id AS "latestTurnId",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    archived_at AS "archivedAt",
    settled_override AS "settledOverride",
    settled_at AS "settledAt",
    snoozed_until AS "snoozedUntil",
    snoozed_at AS "snoozedAt",
    latest_user_message_at AS "latestUserMessageAt",
    pending_approval_count AS "pendingApprovalCount",
    pending_user_input_count AS "pendingUserInputCount",
    has_actionable_proposed_plan AS "hasActionableProposedPlan",
    deleted_at AS "deletedAt"
  `;

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
      sql`
        SELECT
          ${projectRowColumns}
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          ${threadRowColumns}
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  /**
   * Shell-snapshot variants that drop soft-deleted rows in SQL.
   *
   * The shell snapshot discards these rows anyway, so filtering here avoids
   * decoding them and - for projects - avoids resolving a repository identity
   * (filesystem work) for a project the client will never see.
   */
  const listLiveProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
      sql`
        SELECT
          ${projectRowColumns}
        FROM projection_projects
        WHERE deleted_at IS NULL
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listLiveThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          ${threadRowColumns}
        FROM projection_threads
        WHERE deleted_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const listThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          origin_json AS "origin",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        ORDER BY thread_id ASC, created_at ASC, message_id ASC
      `,
  });

  const listThreadProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        ORDER BY thread_id ASC, created_at ASC, plan_id ASC
      `,
  });

  const listQueuedTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionQueuedTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          queued_turn_id AS "queuedTurnId",
          thread_id AS "threadId",
          message_id AS "messageId",
          text,
          attachments_json AS "attachments",
          origin_json AS "origin",
          model_selection_json AS "modelSelection",
          title_seed AS "titleSeed",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          failed_at AS "failedAt",
          failure_message AS "failureMessage"
        FROM projection_queued_turns
        ORDER BY thread_id ASC, created_at ASC, queued_turn_id ASC
      `,
  });

  const listThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        ORDER BY
          thread_id ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listBackgroundAgentActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE kind IN ('task.started', 'task.completed')
        ORDER BY thread_id ASC, created_at ASC, activity_id ASC
      `,
  });

  const threadSessionRowColumns = sql`
    s.thread_id AS "threadId",
    s.status,
    s.provider_name AS "providerName",
    s.provider_instance_id AS "providerInstanceId",
    s.provider_session_id AS "providerSessionId",
    s.provider_thread_id AS "providerThreadId",
    s.runtime_mode AS "runtimeMode",
    s.active_turn_id AS "activeTurnId",
    COALESCE(s.resume_cursor_json, r.resume_cursor_json) AS "resumeCursor",
    s.last_error AS "lastError",
    s.updated_at AS "updatedAt"
  `;

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          ${threadSessionRowColumns}
        FROM projection_thread_sessions s
        LEFT JOIN provider_session_runtime r
          ON r.thread_id = s.thread_id
        ORDER BY s.thread_id ASC
      `,
  });

  const listLiveThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          ${threadSessionRowColumns}
        FROM projection_thread_sessions s
        LEFT JOIN provider_session_runtime r
          ON r.thread_id = s.thread_id
        WHERE EXISTS (
          SELECT 1
          FROM projection_threads t
          WHERE t.thread_id = s.thread_id
            AND t.deleted_at IS NULL
        )
        ORDER BY s.thread_id ASC
      `,
  });

  const listCheckpointRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCheckpointDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          checkpoint_agent_touched_paths_json AS "agentTouchedPaths",
          checkpoint_turn_files_json AS "turnFiles",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE checkpoint_turn_count IS NOT NULL
        ORDER BY thread_id ASC, checkpoint_turn_count ASC
      `,
  });

  const latestTurnRowColumns = sql`
    turns.thread_id AS "threadId",
    turns.turn_id AS "turnId",
    turns.state,
    turns.requested_at AS "requestedAt",
    turns.started_at AS "startedAt",
    turns.completed_at AS "completedAt",
    turns.assistant_message_id AS "assistantMessageId",
    turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
    turns.source_proposed_plan_id AS "sourceProposedPlanId"
  `;

  const latestTurnRowJoin = sql`
    INNER JOIN projection_turns AS turns
      ON turns.row_id = (
        SELECT candidate.row_id
        FROM projection_turns AS candidate
        WHERE candidate.thread_id = threads.thread_id
          AND candidate.turn_id IS NOT NULL
        ORDER BY candidate.requested_at DESC, candidate.turn_id DESC
        LIMIT 1
      )
  `;

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          ${latestTurnRowColumns}
        FROM projection_threads AS threads
        ${latestTurnRowJoin}
        ORDER BY turns.thread_id ASC
      `,
  });

  /**
   * Skips the per-thread correlated lookup for soft-deleted threads, which the
   * shell snapshot never renders.
   */
  const listLiveLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          ${latestTurnRowColumns}
        FROM projection_threads AS threads
        ${latestTurnRowJoin}
        WHERE threads.deleted_at IS NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  /**
   * Snapshot freshness must keep reflecting soft-deleted rows: deleting a
   * project or thread bumps its `updated_at`, and clients rely on
   * `updatedAt` moving so they re-read. The shell snapshot no longer loads
   * those rows, so read their bounds as aggregates instead.
   */
  const readProjectionUpdatedAtBounds = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionUpdatedAtBoundsRowSchema,
    execute: () =>
      sql`
        SELECT
          (SELECT MAX(updated_at) FROM projection_projects) AS "maxProjectUpdatedAt",
          (SELECT MAX(updated_at) FROM projection_threads) AS "maxThreadUpdatedAt",
          (SELECT MAX(updated_at) FROM projection_thread_sessions) AS "maxThreadSessionUpdatedAt"
      `,
  });

  const readTurnSnapshotBounds = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionTurnSnapshotBoundsRowSchema,
    execute: () =>
      sql`
        SELECT
          MAX(requested_at) AS "snapshotMaxRequestedAt",
          MAX(started_at) AS "snapshotMaxStartedAt",
          MAX(completed_at) AS "snapshotMaxCompletedAt"
        FROM projection_turns
        WHERE turn_id IS NOT NULL
      `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
      `,
  });

  const readProjectionCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionCountsRowSchema,
    execute: () =>
      sql`
        SELECT
          (SELECT COUNT(*) FROM projection_projects) AS "projectCount",
          (SELECT COUNT(*) FROM projection_threads) AS "threadCount"
      `,
  });

  const getActiveProjectRowByWorkspaceRoot = SqlSchema.findOneOption({
    Request: WorkspaceRootLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ workspaceRoot }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE workspace_root = ${workspaceRoot}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, project_id ASC
        LIMIT 1
      `,
  });

  const getActiveProjectRowById = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getFirstActiveThreadIdByProject = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId"
        FROM projection_threads
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
        LIMIT 1
      `,
  });

  const getThreadCheckpointContextThreadRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadCheckpointContextThreadRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getActiveThreadRowById = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadWithProjectTitleDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          threads.parent_thread_id AS "parentThreadId",
          threads.title,
          threads.model_selection_json AS "modelSelection",
          threads.runtime_mode AS "runtimeMode",
          threads.pending_runtime_mode AS "pendingRuntimeMode",
          threads.interaction_mode AS "interactionMode",
          threads.branch,
          threads.worktree_path AS "worktreePath",
          threads.pull_request_json AS "pullRequest",
          threads.review_snapshot_json AS "reviewSnapshot",
          threads.review_result_json AS "reviewResult",
          threads.latest_turn_id AS "latestTurnId",
          threads.created_at AS "createdAt",
          threads.updated_at AS "updatedAt",
          threads.archived_at AS "archivedAt",
          threads.settled_override AS "settledOverride",
          threads.settled_at AS "settledAt",
          threads.snoozed_until AS "snoozedUntil",
          threads.snoozed_at AS "snoozedAt",
          threads.latest_user_message_at AS "latestUserMessageAt",
          threads.pending_approval_count AS "pendingApprovalCount",
          threads.pending_user_input_count AS "pendingUserInputCount",
          threads.has_actionable_proposed_plan AS "hasActionableProposedPlan",
          threads.deleted_at AS "deletedAt",
          projects.title AS "projectTitle"
        FROM projection_threads AS threads
        LEFT JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
          AND projects.deleted_at IS NULL
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const listThreadMessageRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          origin_json AS "origin",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const listThreadProposedPlanRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, plan_id ASC
      `,
  });

  const listQueuedTurnRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionQueuedTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          queued_turn_id AS "queuedTurnId",
          thread_id AS "threadId",
          message_id AS "messageId",
          text,
          attachments_json AS "attachments",
          origin_json AS "origin",
          model_selection_json AS "modelSelection",
          title_seed AS "titleSeed",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          failed_at AS "failedAt",
          failure_message AS "failureMessage"
        FROM projection_queued_turns
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, queued_turn_id ASC
      `,
  });

  const listThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadActivitiesLimitInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, limit }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY created_at DESC, activity_id DESC
        LIMIT ${limit}
      `,
  });

  const listThreadActivityRowsBeforeActivity = SqlSchema.findAll({
    Request: ThreadActivitiesBeforeActivityInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, beforeCreatedAt, beforeActivityId, limit }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND (
            created_at < ${beforeCreatedAt}
            OR (
              created_at = ${beforeCreatedAt}
              AND activity_id < ${beforeActivityId}
            )
          )
        ORDER BY
          created_at DESC,
          activity_id DESC
        LIMIT ${limit}
      `,
  });

  const listTurnActivityRowsBeforeActivity = SqlSchema.findAll({
    Request: TurnActivitiesBeforeActivityInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, turnId, beforeCreatedAt, beforeActivityId, limit }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
          AND (
            created_at < ${beforeCreatedAt}
            OR (
              created_at = ${beforeCreatedAt}
              AND activity_id < ${beforeActivityId}
            )
          )
        ORDER BY
          created_at DESC,
          activity_id DESC
        LIMIT ${limit}
      `,
  });

  const findTurnActivityBeforeActivity = SqlSchema.findOneOption({
    Request: TurnActivityExistsBeforeActivityInput,
    Result: TurnActivityExistsRowSchema,
    execute: ({ threadId, turnId, beforeCreatedAt, beforeActivityId }) =>
      sql`
        SELECT
          activity_id AS "activityId"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
          AND (
            created_at < ${beforeCreatedAt}
            OR (
              created_at = ${beforeCreatedAt}
              AND activity_id < ${beforeActivityId}
            )
          )
        LIMIT 1
      `,
  });

  const listThreadActivityContextRows = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        WITH approval_ranked AS (
          SELECT
            activities.*,
            ROW_NUMBER() OVER (
              PARTITION BY json_extract(payload_json, '$.requestId')
              ORDER BY
                created_at DESC,
                CASE WHEN kind = 'approval.requested' THEN 0 ELSE 1 END DESC,
                activity_id DESC
            ) AS lifecycle_rank
          FROM projection_thread_activities AS activities
          WHERE thread_id = ${threadId}
            AND kind IN (
              'approval.requested',
              'approval.resolved',
              'provider.approval.respond.failed'
            )
            AND json_extract(payload_json, '$.requestId') IS NOT NULL
            AND (
              kind <> 'provider.approval.respond.failed'
              OR lower(COALESCE(json_extract(payload_json, '$.detail'), ''))
                LIKE '%stale pending approval request%'
              OR lower(COALESCE(json_extract(payload_json, '$.detail'), ''))
                LIKE '%unknown pending approval request%'
              OR lower(COALESCE(json_extract(payload_json, '$.detail'), ''))
                LIKE '%unknown pending permission request%'
            )
        ),
        user_input_ranked AS (
          SELECT
            activities.*,
            ROW_NUMBER() OVER (
              PARTITION BY json_extract(payload_json, '$.requestId')
              ORDER BY
                created_at DESC,
                CASE WHEN kind = 'user-input.requested' THEN 0 ELSE 1 END DESC,
                activity_id DESC
            ) AS lifecycle_rank
          FROM projection_thread_activities AS activities
          WHERE thread_id = ${threadId}
            AND kind IN (
              'user-input.requested',
              'user-input.resolved',
              'provider.user-input.respond.failed'
            )
            AND json_extract(payload_json, '$.requestId') IS NOT NULL
            AND (
              kind <> 'provider.user-input.respond.failed'
              OR lower(COALESCE(json_extract(payload_json, '$.detail'), ''))
                LIKE '%stale pending user-input request%'
              OR lower(COALESCE(json_extract(payload_json, '$.detail'), ''))
                LIKE '%unknown pending user-input request%'
            )
        ),
        task_ranked AS (
          SELECT
            activities.*,
            ROW_NUMBER() OVER (
              PARTITION BY json_extract(payload_json, '$.taskId')
              ORDER BY
                created_at DESC,
                CASE WHEN kind = 'task.started' THEN 0 ELSE 1 END DESC,
                activity_id DESC
            ) AS lifecycle_rank
          FROM projection_thread_activities AS activities
          WHERE thread_id = ${threadId}
            AND kind IN ('task.started', 'task.completed')
            AND json_extract(payload_json, '$.taskId') IS NOT NULL
            AND (
              kind = 'task.completed'
              OR (
                kind = 'task.started'
                AND json_extract(payload_json, '$.taskType') = 'background-agent'
              )
            )
        ),
        selected AS (
          SELECT * FROM approval_ranked
          WHERE lifecycle_rank = 1 AND kind = 'approval.requested'
          UNION ALL
          SELECT * FROM user_input_ranked
          WHERE lifecycle_rank = 1 AND kind = 'user-input.requested'
          UNION ALL
          SELECT * FROM task_ranked
          WHERE lifecycle_rank = 1 AND kind = 'task.started'
          UNION ALL
          SELECT * FROM (
            SELECT
              activities.*,
              1 AS lifecycle_rank
            FROM projection_thread_activities AS activities
            WHERE thread_id = ${threadId}
              AND kind = 'turn.plan.updated'
            ORDER BY created_at DESC, activity_id DESC
            LIMIT 64
          )
        )
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM selected
        ORDER BY created_at ASC, activity_id ASC
      `,
  });

  const listBackgroundAgentActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND kind IN ('task.started', 'task.completed')
        ORDER BY created_at ASC, activity_id ASC
      `,
  });

  const getThreadSessionRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          s.thread_id AS "threadId",
          s.status,
          s.provider_name AS "providerName",
          s.provider_instance_id AS "providerInstanceId",
          s.runtime_mode AS "runtimeMode",
          s.active_turn_id AS "activeTurnId",
          COALESCE(s.resume_cursor_json, r.resume_cursor_json) AS "resumeCursor",
          s.last_error AS "lastError",
          s.updated_at AS "updatedAt"
        FROM projection_thread_sessions s
        LEFT JOIN provider_session_runtime r
          ON r.thread_id = s.thread_id
        WHERE s.thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const getLatestTurnRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
          AND turns.turn_id IS NOT NULL
        ORDER BY
          CASE WHEN turns.turn_id = threads.latest_turn_id THEN 0 ELSE 1 END ASC,
          turns.requested_at DESC,
          turns.turn_id DESC
        LIMIT 1
      `,
  });

  const listCheckpointRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          checkpoint_agent_touched_paths_json AS "agentTouchedPaths",
          checkpoint_turn_files_json AS "turnFiles",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listThreadMessageRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:decodeRows",
              ),
            ),
          ),
          listThreadProposedPlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:decodeRows",
              ),
            ),
          ),
          listQueuedTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listQueuedTurns:query",
                "ProjectionSnapshotQuery.getSnapshot:listQueuedTurns:decodeRows",
              ),
            ),
          ),
          listThreadActivityRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:decodeRows",
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listCheckpointRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query",
                "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows",
              ),
            ),
          ),
          listLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          readTurnSnapshotBounds(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:readTurnSnapshotBounds:query",
                "ProjectionSnapshotQuery.getSnapshot:readTurnSnapshotBounds:decodeRow",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
          projectionWorkflowRepository.listAll(),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            messageRows,
            proposedPlanRows,
            queuedTurnRows,
            activityRows,
            sessionRows,
            checkpointRows,
            latestTurnRows,
            turnSnapshotBounds,
            stateRows,
            workflowRuns,
          ]) =>
            Effect.gen(function* () {
              const messagesByThread = new Map<string, Array<OrchestrationMessage>>();
              const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
              const queuedTurnsByThread = new Map<string, Array<OrchestrationQueuedTurn>>();
              const activitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>();
              const checkpointsByThread = new Map<string, Array<OrchestrationCheckpointSummary>>();
              const sessionsByThread = new Map<string, OrchestrationSession>();
              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();

              let updatedAt: string | null = null;

              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const run of workflowRuns) {
                updatedAt = maxIso(updatedAt, run.updatedAt);
              }

              for (const row of messageRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadMessages = messagesByThread.get(row.threadId) ?? [];
                threadMessages.push({
                  id: row.messageId,
                  role: row.role,
                  text: row.text,
                  ...(row.attachments !== null ? { attachments: row.attachments } : {}),
                  ...(row.origin !== null ? { origin: row.origin } : {}),
                  turnId: row.turnId,
                  streaming: row.isStreaming === 1,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                messagesByThread.set(row.threadId, threadMessages);
              }

              for (const row of proposedPlanRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
                threadProposedPlans.push({
                  id: row.planId,
                  turnId: row.turnId,
                  planMarkdown: row.planMarkdown,
                  implementedAt: row.implementedAt,
                  implementationThreadId: row.implementationThreadId,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                proposedPlansByThread.set(row.threadId, threadProposedPlans);
              }

              for (const row of queuedTurnRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadQueuedTurns = queuedTurnsByThread.get(row.threadId) ?? [];
                threadQueuedTurns.push(mapQueuedTurnRow(row));
                queuedTurnsByThread.set(row.threadId, threadQueuedTurns);
              }

              for (const row of activityRows) {
                updatedAt = maxIso(updatedAt, row.createdAt);
                const threadActivities = activitiesByThread.get(row.threadId) ?? [];
                threadActivities.push(mapThreadActivityRow(row));
                activitiesByThread.set(row.threadId, threadActivities);
              }

              for (const row of checkpointRows) {
                updatedAt = maxIso(updatedAt, row.completedAt);
                const threadCheckpoints = checkpointsByThread.get(row.threadId) ?? [];
                threadCheckpoints.push({
                  turnId: row.turnId,
                  checkpointTurnCount: row.checkpointTurnCount,
                  checkpointRef: row.checkpointRef,
                  status: row.status,
                  files: row.files,
                  agentTouchedPaths: row.agentTouchedPaths,
                  turnFiles: row.turnFiles,
                  assistantMessageId: row.assistantMessageId,
                  completedAt: row.completedAt,
                });
                checkpointsByThread.set(row.threadId, threadCheckpoints);
              }

              if (turnSnapshotBounds.snapshotMaxRequestedAt !== null) {
                updatedAt = maxIso(updatedAt, turnSnapshotBounds.snapshotMaxRequestedAt);
              }
              if (turnSnapshotBounds.snapshotMaxStartedAt !== null) {
                updatedAt = maxIso(updatedAt, turnSnapshotBounds.snapshotMaxStartedAt);
              }
              if (turnSnapshotBounds.snapshotMaxCompletedAt !== null) {
                updatedAt = maxIso(updatedAt, turnSnapshotBounds.snapshotMaxCompletedAt);
              }
              for (const row of latestTurnRows) {
                latestTurnByThread.set(row.threadId, {
                  turnId: row.turnId,
                  state:
                    row.state === "error"
                      ? "error"
                      : row.state === "interrupted"
                        ? "interrupted"
                        : row.state === "completed"
                          ? "completed"
                          : "running",
                  requestedAt: row.requestedAt,
                  startedAt: row.startedAt,
                  completedAt: row.completedAt,
                  assistantMessageId: row.assistantMessageId,
                  ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
                    ? {
                        sourceProposedPlan: {
                          threadId: row.sourceProposedPlanThreadId,
                          planId: row.sourceProposedPlanId,
                        },
                      }
                    : {}),
                });
              }

              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                sessionsByThread.set(row.threadId, {
                  threadId: row.threadId,
                  status: row.status,
                  providerName: row.providerName,
                  ...(row.providerInstanceId !== null
                    ? { providerInstanceId: row.providerInstanceId }
                    : {}),
                  runtimeMode: row.runtimeMode,
                  activeTurnId: row.activeTurnId,
                  ...(row.resumeCursor !== null ? { resumeCursor: row.resumeCursor } : {}),
                  lastError: row.lastError,
                  updatedAt: row.updatedAt,
                });
              }

              const repositoryIdentities = new Map(
                yield* Effect.forEach(
                  projectRows,
                  (row) =>
                    repositoryIdentityResolver
                      .resolve(row.workspaceRoot)
                      .pipe(Effect.map((identity) => [row.projectId, identity] as const)),
                  { concurrency: repositoryIdentityResolutionConcurrency },
                ),
              );

              const projects: ReadonlyArray<OrchestrationProject> = projectRows.map((row) => ({
                id: row.projectId,
                title: row.title,
                workspaceRoot: row.workspaceRoot,
                repositoryIdentity: repositoryIdentities.get(row.projectId) ?? null,
                defaultModelSelection: row.defaultModelSelection,
                scripts: row.scripts,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                deletedAt: row.deletedAt,
              }));

              const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) => {
                const session = sessionsByThread.get(row.threadId) ?? null;
                return {
                  id: row.threadId,
                  projectId: row.projectId,
                  parentThreadId: row.parentThreadId ?? null,
                  title: row.title,
                  modelSelection: row.modelSelection,
                  runtimeMode: row.runtimeMode,
                  pendingRuntimeMode: row.pendingRuntimeMode,
                  interactionMode: row.interactionMode,
                  branch: row.branch,
                  worktreePath: row.worktreePath,
                  pullRequest: row.pullRequest ?? null,
                  ...(row.reviewSnapshot !== null && row.reviewSnapshot !== undefined
                    ? { reviewSnapshot: row.reviewSnapshot }
                    : {}),
                  reviewResult: row.reviewResult ?? null,
                  latestTurn: reconcileLatestTurnWithSession(
                    latestTurnByThread.get(row.threadId) ?? null,
                    session,
                  ),
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  archivedAt: row.archivedAt,
                  settledOverride: row.settledOverride,
                  settledAt: row.settledAt,
                  snoozedUntil: row.snoozedUntil,
                  snoozedAt: row.snoozedAt,
                  deletedAt: row.deletedAt,
                  messages: messagesByThread.get(row.threadId) ?? [],
                  proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                  queuedTurns: queuedTurnsByThread.get(row.threadId) ?? [],
                  activities: activitiesByThread.get(row.threadId) ?? [],
                  hasMoreActivities: false,
                  checkpoints: checkpointsByThread.get(row.threadId) ?? [],
                  session,
                };
              });

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects,
                threads,
                workflowRuns,
                updatedAt: updatedAt ?? new Date(0).toISOString(),
              };

              return yield* decodeReadModel(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError("ProjectionSnapshotQuery.getSnapshot:decodeReadModel"),
                ),
              );
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getSnapshot:query")(error);
        }),
      );

  const getShellSnapshot: ProjectionSnapshotQueryShape["getShellSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listLiveProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listLiveThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listLiveThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listLiveLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          readTurnSnapshotBounds(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:readTurnSnapshotBounds:query",
                "ProjectionSnapshotQuery.getShellSnapshot:readTurnSnapshotBounds:decodeRow",
              ),
            ),
          ),
          listBackgroundAgentActivityRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listBackgroundAgentActivities:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listBackgroundAgentActivities:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
          projectionWorkflowRepository.listShellSnapshot(),
          readProjectionUpdatedAtBounds(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:readProjectionUpdatedAtBounds:query",
                "ProjectionSnapshotQuery.getShellSnapshot:readProjectionUpdatedAtBounds:decodeRow",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            sessionRows,
            latestTurnRows,
            turnSnapshotBounds,
            backgroundAgentActivityRows,
            stateRows,
            workflowSnapshot,
            updatedAtBounds,
          ]) =>
            Effect.gen(function* () {
              const { artifacts: workflowArtifacts, runs: workflowRuns } = workflowSnapshot;
              let updatedAt: string | null = null;
              // Aggregates rather than row folds: the row queries above exclude
              // soft-deleted rows, but a delete bumps `updated_at` and must
              // still move snapshot freshness.
              if (updatedAtBounds.maxProjectUpdatedAt !== null) {
                updatedAt = maxIso(updatedAt, updatedAtBounds.maxProjectUpdatedAt);
              }
              if (updatedAtBounds.maxThreadUpdatedAt !== null) {
                updatedAt = maxIso(updatedAt, updatedAtBounds.maxThreadUpdatedAt);
              }
              if (updatedAtBounds.maxThreadSessionUpdatedAt !== null) {
                updatedAt = maxIso(updatedAt, updatedAtBounds.maxThreadSessionUpdatedAt);
              }
              if (turnSnapshotBounds.snapshotMaxRequestedAt !== null) {
                updatedAt = maxIso(updatedAt, turnSnapshotBounds.snapshotMaxRequestedAt);
              }
              if (turnSnapshotBounds.snapshotMaxStartedAt !== null) {
                updatedAt = maxIso(updatedAt, turnSnapshotBounds.snapshotMaxStartedAt);
              }
              if (turnSnapshotBounds.snapshotMaxCompletedAt !== null) {
                updatedAt = maxIso(updatedAt, turnSnapshotBounds.snapshotMaxCompletedAt);
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const run of workflowRuns) {
                updatedAt = maxIso(updatedAt, run.run.updatedAt);
              }
              for (const artifact of workflowArtifacts) {
                updatedAt = maxIso(updatedAt, artifact.createdAt);
              }

              const repositoryIdentities = new Map(
                yield* Effect.forEach(
                  projectRows,
                  (row) =>
                    repositoryIdentityResolver
                      .resolve(row.workspaceRoot)
                      .pipe(Effect.map((identity) => [row.projectId, identity] as const)),
                  { concurrency: repositoryIdentityResolutionConcurrency },
                ),
              );
              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();
              for (const row of latestTurnRows) {
                latestTurnByThread.set(row.threadId, mapLatestTurn(row));
              }
              const sessionByThread = new Map(
                sessionRows.map((row) => [row.threadId, mapSessionRow(row)] as const),
              );
              const backgroundAgentRunsByThread = deriveBackgroundAgentRunsByThread(
                backgroundAgentActivityRows,
              );

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects: projectRows.map((row) =>
                  mapProjectShellRow(row, repositoryIdentities.get(row.projectId) ?? null),
                ),
                threads: threadRows.map((row): OrchestrationThreadShell => {
                  const session = sessionByThread.get(row.threadId) ?? null;
                  return {
                    id: row.threadId,
                    projectId: row.projectId,
                    parentThreadId: row.parentThreadId ?? null,
                    title: row.title,
                    modelSelection: row.modelSelection,
                    runtimeMode: row.runtimeMode,
                    pendingRuntimeMode: row.pendingRuntimeMode,
                    interactionMode: row.interactionMode,
                    branch: row.branch,
                    worktreePath: row.worktreePath,
                    pullRequest: row.pullRequest ?? null,
                    latestTurn: reconcileLatestTurnWithSession(
                      latestTurnByThread.get(row.threadId) ?? null,
                      session,
                    ),
                    createdAt: row.createdAt,
                    updatedAt: row.updatedAt,
                    archivedAt: row.archivedAt,
                    settledOverride: row.settledOverride,
                    settledAt: row.settledAt,
                    snoozedUntil: row.snoozedUntil,
                    snoozedAt: row.snoozedAt,
                    session,
                    latestUserMessageAt: row.latestUserMessageAt,
                    hasPendingApprovals: row.pendingApprovalCount > 0,
                    hasPendingUserInput: row.pendingUserInputCount > 0,
                    hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                    ...(backgroundAgentRunsByThread.get(row.threadId)?.length
                      ? { backgroundAgentRuns: backgroundAgentRunsByThread.get(row.threadId)! }
                      : {}),
                  };
                }),
                workflowRuns,
                workflowArtifacts,
                updatedAt: updatedAt ?? new Date(0).toISOString(),
              };

              return yield* decodeShellSnapshot(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:decodeShellSnapshot",
                  ),
                ),
              );
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getShellSnapshot:query")(error);
        }),
      );

  const getSnapshotSequence: ProjectionSnapshotQueryShape["getSnapshotSequence"] = () =>
    listProjectionStateRows(undefined).pipe(
      Effect.map(computeSnapshotSequence),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getSnapshotSequence:query",
          "ProjectionSnapshotQuery.getSnapshotSequence:decodeRows",
        ),
      ),
    );

  const getCounts: ProjectionSnapshotQueryShape["getCounts"] = () =>
    readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getCounts:query",
          "ProjectionSnapshotQuery.getCounts:decodeRow",
        ),
      ),
      Effect.map(
        (row): ProjectionSnapshotCounts => ({
          projectCount: row.projectCount,
          threadCount: row.threadCount,
        }),
      ),
    );

  const getActiveProjectByWorkspaceRoot: ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"] =
    (workspaceRoot) =>
      getActiveProjectRowByWorkspaceRoot({ workspaceRoot }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query",
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeRow",
          ),
        ),
        Effect.flatMap((option) =>
          Option.isNone(option)
            ? Effect.succeed(Option.none<OrchestrationProject>())
            : repositoryIdentityResolver.resolve(option.value.workspaceRoot).pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some({
                    id: option.value.projectId,
                    title: option.value.title,
                    workspaceRoot: option.value.workspaceRoot,
                    repositoryIdentity,
                    defaultModelSelection: option.value.defaultModelSelection,
                    scripts: option.value.scripts,
                    createdAt: option.value.createdAt,
                    updatedAt: option.value.updatedAt,
                    deletedAt: option.value.deletedAt,
                  } satisfies OrchestrationProject),
                ),
              ),
        ),
      );

  const getProjectShellById: ProjectionSnapshotQueryShape["getProjectShellById"] = (projectId) =>
    getActiveProjectRowById({ projectId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getProjectShellById:query",
          "ProjectionSnapshotQuery.getProjectShellById:decodeRow",
        ),
      ),
      Effect.flatMap((option) =>
        Option.isNone(option)
          ? Effect.succeed(Option.none<OrchestrationProjectShell>())
          : repositoryIdentityResolver
              .resolve(option.value.workspaceRoot)
              .pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some(mapProjectShellRow(option.value, repositoryIdentity)),
                ),
              ),
      ),
    );

  const getFirstActiveThreadIdByProjectId: ProjectionSnapshotQueryShape["getFirstActiveThreadIdByProjectId"] =
    (projectId) =>
      getFirstActiveThreadIdByProject({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:query",
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:decodeRow",
          ),
        ),
        Effect.map(Option.map((row) => row.threadId)),
      );

  const getThreadCheckpointContext: ProjectionSnapshotQueryShape["getThreadCheckpointContext"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const threadRow = yield* getThreadCheckpointContextThreadRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:decodeRow",
          ),
        ),
      );
      if (Option.isNone(threadRow)) {
        return Option.none<ProjectionThreadCheckpointContext>();
      }

      const checkpointRows = yield* listCheckpointRowsByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:decodeRows",
          ),
        ),
      );

      return Option.some({
        threadId: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        workspaceRoot: threadRow.value.workspaceRoot,
        worktreePath: threadRow.value.worktreePath,
        checkpoints: checkpointRows.map(
          (row): OrchestrationCheckpointSummary => ({
            turnId: row.turnId,
            checkpointTurnCount: row.checkpointTurnCount,
            checkpointRef: row.checkpointRef,
            status: row.status,
            files: row.files,
            agentTouchedPaths: row.agentTouchedPaths,
            turnFiles: row.turnFiles,
            assistantMessageId: row.assistantMessageId,
            completedAt: row.completedAt,
          }),
        ),
      });
    });

  const getThreadShellProjectContextById: ProjectionSnapshotQueryShape["getThreadShellProjectContextById"] =
    (threadId) =>
      Effect.gen(function* () {
        const [threadRow, latestTurnRow, sessionRow, backgroundAgentActivityRows] =
          yield* Effect.all([
            getActiveThreadRowById({ threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadShellById:getThread:query",
                  "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeRow",
                ),
              ),
            ),
            getLatestTurnRowByThread({ threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:query",
                  "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:decodeRow",
                ),
              ),
            ),
            getThreadSessionRowByThread({ threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadShellById:getSession:query",
                  "ProjectionSnapshotQuery.getThreadShellById:getSession:decodeRow",
                ),
              ),
            ),
            listBackgroundAgentActivityRowsByThread({ threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadShellById:listBackgroundAgentActivities:query",
                  "ProjectionSnapshotQuery.getThreadShellById:listBackgroundAgentActivities:decodeRows",
                ),
              ),
            ),
          ]);

        if (Option.isNone(threadRow)) {
          return Option.none<ProjectionThreadShellProjectContext>();
        }

        const session = Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null;
        const backgroundAgentRuns =
          deriveBackgroundAgentRunsByThread(backgroundAgentActivityRows).get(threadId) ?? [];

        return Option.some({
          thread: {
            id: threadRow.value.threadId,
            projectId: threadRow.value.projectId,
            parentThreadId: threadRow.value.parentThreadId ?? null,
            title: threadRow.value.title,
            modelSelection: threadRow.value.modelSelection,
            runtimeMode: threadRow.value.runtimeMode,
            pendingRuntimeMode: threadRow.value.pendingRuntimeMode,
            interactionMode: threadRow.value.interactionMode,
            branch: threadRow.value.branch,
            worktreePath: threadRow.value.worktreePath,
            pullRequest: threadRow.value.pullRequest ?? null,
            latestTurn: reconcileLatestTurnWithSession(
              Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
              session,
            ),
            createdAt: threadRow.value.createdAt,
            updatedAt: threadRow.value.updatedAt,
            archivedAt: threadRow.value.archivedAt,
            settledOverride: threadRow.value.settledOverride,
            settledAt: threadRow.value.settledAt,
            snoozedUntil: threadRow.value.snoozedUntil,
            snoozedAt: threadRow.value.snoozedAt,
            session,
            latestUserMessageAt: threadRow.value.latestUserMessageAt,
            hasPendingApprovals: threadRow.value.pendingApprovalCount > 0,
            hasPendingUserInput: threadRow.value.pendingUserInputCount > 0,
            hasActionableProposedPlan: threadRow.value.hasActionableProposedPlan > 0,
            ...(backgroundAgentRuns.length > 0 ? { backgroundAgentRuns } : {}),
          },
          project:
            threadRow.value.projectTitle === null ? null : { title: threadRow.value.projectTitle },
        } satisfies ProjectionThreadShellProjectContext);
      });

  const getThreadShellById: ProjectionSnapshotQueryShape["getThreadShellById"] = (threadId) =>
    getThreadShellProjectContextById(threadId).pipe(
      Effect.map(Option.map((context) => context.thread)),
    );

  const listLatestThreadActivityRows = (threadId: ThreadId, limit: number) =>
    listThreadActivityRowsByThread({
      threadId,
      limit,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.listLatestThreadActivityRows:query",
          "ProjectionSnapshotQuery.listLatestThreadActivityRows:decodeRows",
        ),
      ),
    );

  const getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"] = (threadId) =>
    Effect.gen(function* () {
      const [
        threadRow,
        messageRows,
        proposedPlanRows,
        queuedTurnRows,
        activityRows,
        activityContextRows,
        checkpointRows,
        latestTurnRow,
        sessionRow,
      ] = yield* Effect.all([
        getActiveThreadRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getThread:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getThread:decodeRow",
            ),
          ),
        ),
        listThreadMessageRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:decodeRows",
            ),
          ),
        ),
        listThreadProposedPlanRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:decodeRows",
            ),
          ),
        ),
        listQueuedTurnRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listQueuedTurns:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listQueuedTurns:decodeRows",
            ),
          ),
        ),
        listLatestThreadActivityRows(threadId, THREAD_DETAIL_ACTIVITY_WINDOW + 1),
        listThreadActivityContextRows({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listActivityContext:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listActivityContext:decodeRows",
            ),
          ),
        ),
        listCheckpointRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:decodeRows",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:decodeRow",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThread>();
      }

      const session = Option.isSome(sessionRow) ? mapSessionRow(sessionRow.value) : null;
      const latestTurn = reconcileLatestTurnWithSession(
        Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        session,
      );
      const visibleActivities = activityRows
        .slice(0, THREAD_DETAIL_ACTIVITY_WINDOW)
        .map(mapThreadActivityRow)
        .toReversed();
      const visibleActivityIds = new Set(visibleActivities.map((activity) => activity.id));
      // Turns can interleave by created_at, so the first omitted global row is
      // not proof that the latest turn still has older history. Ask the DB
      // whether any latest-turn row sits before the visible window boundary.
      const oldestVisibleActivity = activityRows[THREAD_DETAIL_ACTIVITY_WINDOW - 1];
      const hasMoreCurrentTurnActivities =
        latestTurn !== null &&
        activityRows.length > THREAD_DETAIL_ACTIVITY_WINDOW &&
        oldestVisibleActivity !== undefined
          ? Option.isSome(
              yield* findTurnActivityBeforeActivity({
                threadId,
                turnId: latestTurn.turnId,
                beforeCreatedAt: oldestVisibleActivity.createdAt,
                beforeActivityId: oldestVisibleActivity.activityId,
              }).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getThreadDetailById:hasMoreCurrentTurnActivities:query",
                    "ProjectionSnapshotQuery.getThreadDetailById:hasMoreCurrentTurnActivities:decodeRow",
                  ),
                ),
              ),
            )
          : false;

      const thread = {
        id: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        parentThreadId: threadRow.value.parentThreadId ?? null,
        title: threadRow.value.title,
        modelSelection: threadRow.value.modelSelection,
        runtimeMode: threadRow.value.runtimeMode,
        pendingRuntimeMode: threadRow.value.pendingRuntimeMode,
        interactionMode: threadRow.value.interactionMode,
        branch: threadRow.value.branch,
        worktreePath: threadRow.value.worktreePath,
        pullRequest: threadRow.value.pullRequest ?? null,
        ...(threadRow.value.reviewSnapshot !== null && threadRow.value.reviewSnapshot !== undefined
          ? { reviewSnapshot: threadRow.value.reviewSnapshot }
          : {}),
        reviewResult: threadRow.value.reviewResult ?? null,
        latestTurn,
        createdAt: threadRow.value.createdAt,
        updatedAt: threadRow.value.updatedAt,
        archivedAt: threadRow.value.archivedAt,
        settledOverride: threadRow.value.settledOverride,
        settledAt: threadRow.value.settledAt,
        snoozedUntil: threadRow.value.snoozedUntil,
        snoozedAt: threadRow.value.snoozedAt,
        deletedAt: null,
        messages: messageRows.map((row) => {
          const message = {
            id: row.messageId,
            role: row.role,
            text: row.text,
            turnId: row.turnId,
            streaming: row.isStreaming === 1,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
          return Object.assign(
            message,
            row.attachments !== null ? { attachments: row.attachments } : {},
            row.origin !== null ? { origin: row.origin } : {},
          );
        }),
        proposedPlans: proposedPlanRows.map((row) => ({
          id: row.planId,
          turnId: row.turnId,
          planMarkdown: row.planMarkdown,
          implementedAt: row.implementedAt,
          implementationThreadId: row.implementationThreadId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
        queuedTurns: queuedTurnRows.map(mapQueuedTurnRow),
        activities: visibleActivities,
        activityContext: activityContextRows
          .map(mapThreadActivityRow)
          .filter((activity) => !visibleActivityIds.has(activity.id)),
        hasMoreActivities: activityRows.length > THREAD_DETAIL_ACTIVITY_WINDOW,
        hasMoreCurrentTurnActivities,
        checkpoints: checkpointRows.map((row) => ({
          turnId: row.turnId,
          checkpointTurnCount: row.checkpointTurnCount,
          checkpointRef: row.checkpointRef,
          status: row.status,
          files: row.files,
          agentTouchedPaths: row.agentTouchedPaths,
          turnFiles: row.turnFiles,
          assistantMessageId: row.assistantMessageId,
          completedAt: row.completedAt,
        })),
        session,
      };

      return Option.some(
        yield* decodeThread(thread).pipe(
          Effect.mapError(
            toPersistenceDecodeError("ProjectionSnapshotQuery.getThreadDetailById:decodeThread"),
          ),
        ),
      );
    });

  const getThreadDetailSnapshotById: ProjectionSnapshotQueryShape["getThreadDetailSnapshotById"] = (
    threadId,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const snapshotSequence = yield* getSnapshotSequence();
          const thread = yield* getThreadDetailById(threadId);
          return Option.map(thread, (value) => ({
            snapshotSequence,
            thread: value,
          }));
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getThreadDetailSnapshotById:query")(
            error,
          );
        }),
      );

  const getThreadActivitiesPage: ProjectionSnapshotQueryShape["getThreadActivitiesPage"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const limit = Math.min(
        Math.max(1, input.limit ?? THREAD_DETAIL_ACTIVITY_WINDOW),
        THREAD_DETAIL_ACTIVITY_WINDOW,
      );
      const queryInput = {
        threadId: input.threadId,
        beforeCreatedAt: input.beforeCreatedAt,
        beforeActivityId: input.beforeActivityId,
        limit: limit + 1,
      };
      const rows = yield* (
        input.turnId === undefined
          ? listThreadActivityRowsBeforeActivity(queryInput)
          : listTurnActivityRowsBeforeActivity({
              ...queryInput,
              turnId: input.turnId,
            })
      ).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadActivitiesPage:query",
            "ProjectionSnapshotQuery.getThreadActivitiesPage:decodeRows",
          ),
        ),
      );
      const hasMore = rows.length > limit;
      return {
        activities: (hasMore ? rows.slice(0, limit) : rows).map(mapThreadActivityRow).toReversed(),
        hasMore,
      };
    });

  const searchTranscript: NonNullable<ProjectionSnapshotQueryShape["searchTranscript"]> = (
    query,
  ) => {
    const normalizedQuery = query.trim().replace(/\s+/g, " ");
    if (normalizedQuery.length < 3) {
      return Effect.succeed({ matches: [] });
    }
    const literalQuery = `"${normalizedQuery.replaceAll('"', '""')}"`;
    return SqlSchema.findAll({
      Request: Schema.Struct({ query: Schema.String }),
      Result: TranscriptSearchRowSchema,
      execute: ({ query: matchQuery }) => sql`
        WITH hits AS MATERIALIZED (
          SELECT
            projection_thread_message_fts.rowid AS "messageRowid",
            messages.message_id AS "messageId",
            messages.thread_id AS "threadId",
            messages.updated_at AS "updatedAt",
            rank AS score
          FROM projection_thread_message_fts
          JOIN projection_thread_messages AS messages
            ON messages.rowid = projection_thread_message_fts.rowid
          JOIN projection_threads AS threads ON threads.thread_id = messages.thread_id
          WHERE projection_thread_message_fts MATCH ${matchQuery}
            AND threads.archived_at IS NULL
            AND threads.deleted_at IS NULL
        ),
        ranked AS (
          SELECT
            hits.*,
            ROW_NUMBER() OVER (
              PARTITION BY "threadId"
              ORDER BY score, "updatedAt" DESC, "messageId"
            ) AS "threadRank"
          FROM hits
        ),
        top_hits AS MATERIALIZED (
          SELECT *
          FROM ranked
          WHERE "threadRank" = 1
          ORDER BY score, "updatedAt" DESC, "threadId"
          LIMIT 20
        )
        SELECT
          top_hits."threadId",
          threads.title,
          projects.title AS "projectTitle",
          threads.branch,
          messages.role,
          snippet(projection_thread_message_fts, 0, '', '', '...', 20) AS excerpt,
          top_hits."updatedAt"
        FROM top_hits
        JOIN projection_thread_messages AS messages
          ON messages.rowid = top_hits."messageRowid"
        JOIN projection_threads AS threads ON threads.thread_id = top_hits."threadId"
        LEFT JOIN projection_projects AS projects ON projects.project_id = threads.project_id
        JOIN projection_thread_message_fts
          ON projection_thread_message_fts.rowid = top_hits."messageRowid"
        WHERE projection_thread_message_fts MATCH ${matchQuery}
        ORDER BY top_hits.score, top_hits."updatedAt" DESC, top_hits."threadId"
      `,
    })({ query: literalQuery }).pipe(
      Effect.map((matches) => ({ matches })),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.searchTranscript:query",
          "ProjectionSnapshotQuery.searchTranscript:decodeRows",
        ),
      ),
    );
  };

  return {
    getSnapshot,
    getShellSnapshot,
    getSnapshotSequence,
    getCounts,
    getActiveProjectByWorkspaceRoot,
    getProjectShellById,
    getFirstActiveThreadIdByProjectId,
    getThreadCheckpointContext,
    getThreadShellById,
    getThreadShellProjectContextById,
    getThreadDetailById,
    getThreadDetailSnapshotById,
    getThreadActivitiesPage,
    searchTranscript,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
).pipe(Layer.provideMerge(ProjectionWorkflowRepositoryLive));
