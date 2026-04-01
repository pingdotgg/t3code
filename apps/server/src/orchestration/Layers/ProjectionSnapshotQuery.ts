import {
  ChatAttachment,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationArchivedThreadSummary,
  OrchestrationCheckpointFile,
  OrchestrationProposedPlanId,
  OrchestrationReadModel,
  ProjectScript,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationProject,
  type OrchestrationSession,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  ModelSelection,
  ProjectId,
  ThreadId,
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
import { ProjectionThreadSession } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotCounts,
  type ProjectionThreadCheckpointContext,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
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
  }),
);
const ProjectionThreadProposedPlanDbRowSchema = ProjectionThreadProposedPlan;
const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
  }),
);
const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession;
const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
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
const ProjectionStateDbRowSchema = ProjectionState;
const ProjectionArchivedThreadSummaryRowSchema = OrchestrationArchivedThreadSummary;
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
type ProjectionProjectDbRow = Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>;
type ProjectionThreadDbRow = Schema.Schema.Type<typeof ProjectionThreadDbRowSchema>;
type ProjectionThreadMessageDbRow = Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>;
type ProjectionThreadProposedPlanDbRow = Schema.Schema.Type<
  typeof ProjectionThreadProposedPlanDbRowSchema
>;
type ProjectionThreadActivityDbRow = Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>;
type ProjectionThreadSessionDbRow = Schema.Schema.Type<typeof ProjectionThreadSessionDbRowSchema>;
type ProjectionCheckpointDbRow = Schema.Schema.Type<typeof ProjectionCheckpointDbRowSchema>;
type ProjectionLatestTurnDbRow = Schema.Schema.Type<typeof ProjectionLatestTurnDbRowSchema>;
type ProjectionStateDbRow = Schema.Schema.Type<typeof ProjectionStateDbRowSchema>;

const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.projects,
  ORCHESTRATION_PROJECTOR_NAMES.threads,
  ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
  ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
  ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
  ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
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

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
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
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listActiveProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
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
        WHERE deleted_at IS NULL
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const listActiveThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE deleted_at IS NULL
          AND archived_at IS NULL
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
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        ORDER BY thread_id ASC, created_at ASC, message_id ASC
      `,
  });

  const listActiveThreadMessageRows = SqlSchema.findAll({
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
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id IN (
          SELECT thread_id
          FROM projection_threads
          WHERE deleted_at IS NULL
            AND archived_at IS NULL
        )
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

  const listActiveThreadProposedPlanRows = SqlSchema.findAll({
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
        WHERE thread_id IN (
          SELECT thread_id
          FROM projection_threads
          WHERE deleted_at IS NULL
            AND archived_at IS NULL
        )
        ORDER BY thread_id ASC, created_at ASC, plan_id ASC
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
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listActiveThreadActivityRows = SqlSchema.findAll({
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
        WHERE thread_id IN (
          SELECT thread_id
          FROM projection_threads
          WHERE deleted_at IS NULL
            AND archived_at IS NULL
        )
        ORDER BY
          thread_id ASC,
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `,
  });

  const listActiveThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id IN (
          SELECT thread_id
          FROM projection_threads
          WHERE deleted_at IS NULL
            AND archived_at IS NULL
        )
        ORDER BY thread_id ASC
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
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE checkpoint_turn_count IS NOT NULL
        ORDER BY thread_id ASC, checkpoint_turn_count ASC
      `,
  });

  const listActiveCheckpointRows = SqlSchema.findAll({
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
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE checkpoint_turn_count IS NOT NULL
          AND thread_id IN (
            SELECT thread_id
            FROM projection_threads
            WHERE deleted_at IS NULL
              AND archived_at IS NULL
          )
        ORDER BY thread_id ASC, checkpoint_turn_count ASC
      `,
  });

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          assistant_message_id AS "assistantMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_turns
        WHERE turn_id IS NOT NULL
        ORDER BY thread_id ASC, requested_at DESC, turn_id DESC
      `,
  });

  const listActiveLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          assistant_message_id AS "assistantMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_turns
        WHERE turn_id IS NOT NULL
          AND thread_id IN (
            SELECT thread_id
            FROM projection_threads
            WHERE deleted_at IS NULL
              AND archived_at IS NULL
          )
        ORDER BY thread_id ASC, requested_at DESC, turn_id DESC
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

  const listArchivedThreadSummaryRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionArchivedThreadSummaryRowSchema,
    execute: () =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.title AS "projectTitle",
          projects.workspace_root AS "workspaceRoot",
          threads.title,
          threads.worktree_path AS "worktreePath",
          threads.created_at AS "createdAt",
          threads.updated_at AS "updatedAt",
          threads.archived_at AS "archivedAt"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NOT NULL
          AND projects.deleted_at IS NULL
        ORDER BY threads.archived_at DESC, threads.thread_id DESC
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
          AND archived_at IS NULL
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
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  const buildSnapshot = (input: {
    readonly operationPrefix: string;
    readonly projectRows: ReadonlyArray<ProjectionProjectDbRow>;
    readonly threadRows: ReadonlyArray<ProjectionThreadDbRow>;
    readonly messageRows: ReadonlyArray<ProjectionThreadMessageDbRow>;
    readonly proposedPlanRows: ReadonlyArray<ProjectionThreadProposedPlanDbRow>;
    readonly activityRows: ReadonlyArray<ProjectionThreadActivityDbRow>;
    readonly sessionRows: ReadonlyArray<ProjectionThreadSessionDbRow>;
    readonly checkpointRows: ReadonlyArray<ProjectionCheckpointDbRow>;
    readonly latestTurnRows: ReadonlyArray<ProjectionLatestTurnDbRow>;
    readonly stateRows: ReadonlyArray<ProjectionStateDbRow>;
  }) => {
    const messagesByThread = new Map<string, Array<OrchestrationMessage>>();
    const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
    const activitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>();
    const checkpointsByThread = new Map<string, Array<OrchestrationCheckpointSummary>>();
    const sessionsByThread = new Map<string, OrchestrationSession>();
    const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();

    let updatedAt: string | null = null;

    for (const row of input.projectRows) {
      updatedAt = maxIso(updatedAt, row.updatedAt);
    }
    for (const row of input.threadRows) {
      updatedAt = maxIso(updatedAt, row.updatedAt);
    }
    for (const row of input.stateRows) {
      updatedAt = maxIso(updatedAt, row.updatedAt);
    }

    for (const row of input.messageRows) {
      updatedAt = maxIso(updatedAt, row.updatedAt);
      const threadMessages = messagesByThread.get(row.threadId) ?? [];
      threadMessages.push({
        id: row.messageId,
        role: row.role,
        text: row.text,
        ...(row.attachments !== null ? { attachments: row.attachments } : {}),
        turnId: row.turnId,
        streaming: row.isStreaming === 1,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
      messagesByThread.set(row.threadId, threadMessages);
    }

    for (const row of input.proposedPlanRows) {
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

    for (const row of input.activityRows) {
      updatedAt = maxIso(updatedAt, row.createdAt);
      const threadActivities = activitiesByThread.get(row.threadId) ?? [];
      threadActivities.push({
        id: row.activityId,
        tone: row.tone,
        kind: row.kind,
        summary: row.summary,
        payload: row.payload,
        turnId: row.turnId,
        ...(row.sequence !== null ? { sequence: row.sequence } : {}),
        createdAt: row.createdAt,
      });
      activitiesByThread.set(row.threadId, threadActivities);
    }

    for (const row of input.checkpointRows) {
      updatedAt = maxIso(updatedAt, row.completedAt);
      const threadCheckpoints = checkpointsByThread.get(row.threadId) ?? [];
      threadCheckpoints.push({
        turnId: row.turnId,
        checkpointTurnCount: row.checkpointTurnCount,
        checkpointRef: row.checkpointRef,
        status: row.status,
        files: row.files,
        assistantMessageId: row.assistantMessageId,
        completedAt: row.completedAt,
      });
      checkpointsByThread.set(row.threadId, threadCheckpoints);
    }

    for (const row of input.latestTurnRows) {
      updatedAt = maxIso(updatedAt, row.requestedAt);
      if (row.startedAt !== null) {
        updatedAt = maxIso(updatedAt, row.startedAt);
      }
      if (row.completedAt !== null) {
        updatedAt = maxIso(updatedAt, row.completedAt);
      }
      if (latestTurnByThread.has(row.threadId)) {
        continue;
      }
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

    for (const row of input.sessionRows) {
      updatedAt = maxIso(updatedAt, row.updatedAt);
      sessionsByThread.set(row.threadId, {
        threadId: row.threadId,
        status: row.status,
        providerName: row.providerName,
        runtimeMode: row.runtimeMode,
        activeTurnId: row.activeTurnId,
        lastError: row.lastError,
        updatedAt: row.updatedAt,
      });
    }

    const projects: ReadonlyArray<OrchestrationProject> = input.projectRows.map((row) => ({
      id: row.projectId,
      title: row.title,
      workspaceRoot: row.workspaceRoot,
      defaultModelSelection: row.defaultModelSelection,
      scripts: row.scripts,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    }));

    const threads: ReadonlyArray<OrchestrationThread> = input.threadRows.map((row) => ({
      id: row.threadId,
      projectId: row.projectId,
      title: row.title,
      modelSelection: row.modelSelection,
      runtimeMode: row.runtimeMode,
      interactionMode: row.interactionMode,
      branch: row.branch,
      worktreePath: row.worktreePath,
      latestTurn: latestTurnByThread.get(row.threadId) ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
      deletedAt: row.deletedAt,
      messages: messagesByThread.get(row.threadId) ?? [],
      proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
      activities: activitiesByThread.get(row.threadId) ?? [],
      checkpoints: checkpointsByThread.get(row.threadId) ?? [],
      session: sessionsByThread.get(row.threadId) ?? null,
    }));

    return decodeReadModel({
      snapshotSequence: computeSnapshotSequence(input.stateRows),
      projects,
      threads,
      updatedAt: updatedAt ?? new Date(0).toISOString(),
    }).pipe(Effect.mapError(toPersistenceDecodeError(`${input.operationPrefix}:decodeReadModel`)));
  };

  const getSnapshotFromQueries = (input: {
    readonly operationPrefix: string;
    readonly loadProjectRows: Effect.Effect<
      ReadonlyArray<ProjectionProjectDbRow>,
      ProjectionRepositoryError
    >;
    readonly loadThreadRows: Effect.Effect<
      ReadonlyArray<ProjectionThreadDbRow>,
      ProjectionRepositoryError
    >;
    readonly loadMessageRows: Effect.Effect<
      ReadonlyArray<ProjectionThreadMessageDbRow>,
      ProjectionRepositoryError
    >;
    readonly loadProposedPlanRows: Effect.Effect<
      ReadonlyArray<ProjectionThreadProposedPlanDbRow>,
      ProjectionRepositoryError
    >;
    readonly loadActivityRows: Effect.Effect<
      ReadonlyArray<ProjectionThreadActivityDbRow>,
      ProjectionRepositoryError
    >;
    readonly loadSessionRows: Effect.Effect<
      ReadonlyArray<ProjectionThreadSessionDbRow>,
      ProjectionRepositoryError
    >;
    readonly loadCheckpointRows: Effect.Effect<
      ReadonlyArray<ProjectionCheckpointDbRow>,
      ProjectionRepositoryError
    >;
    readonly loadLatestTurnRows: Effect.Effect<
      ReadonlyArray<ProjectionLatestTurnDbRow>,
      ProjectionRepositoryError
    >;
  }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [
            projectRows,
            threadRows,
            messageRows,
            proposedPlanRows,
            activityRows,
            sessionRows,
            checkpointRows,
            latestTurnRows,
            stateRows,
          ] = yield* Effect.all([
            input.loadProjectRows,
            input.loadThreadRows,
            input.loadMessageRows,
            input.loadProposedPlanRows,
            input.loadActivityRows,
            input.loadSessionRows,
            input.loadCheckpointRows,
            input.loadLatestTurnRows,
            listProjectionStateRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  `${input.operationPrefix}:listProjectionState:query`,
                  `${input.operationPrefix}:listProjectionState:decodeRows`,
                ),
              ),
            ),
          ]);

          return yield* buildSnapshot({
            operationPrefix: input.operationPrefix,
            projectRows,
            threadRows,
            messageRows,
            proposedPlanRows,
            activityRows,
            sessionRows,
            checkpointRows,
            latestTurnRows,
            stateRows,
          });
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError(`${input.operationPrefix}:query`)(error);
        }),
      );

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = () =>
    getSnapshotFromQueries({
      operationPrefix: "ProjectionSnapshotQuery.getSnapshot",
      loadProjectRows: listProjectRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
            "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
          ),
        ),
      ),
      loadThreadRows: listThreadRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getSnapshot:listThreads:query",
            "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows",
          ),
        ),
      ),
      loadMessageRows: listThreadMessageRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:query",
            "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:decodeRows",
          ),
        ),
      ),
      loadProposedPlanRows: listThreadProposedPlanRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:query",
            "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:decodeRows",
          ),
        ),
      ),
      loadActivityRows: listThreadActivityRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:query",
            "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:decodeRows",
          ),
        ),
      ),
      loadSessionRows: listThreadSessionRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query",
            "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows",
          ),
        ),
      ),
      loadCheckpointRows: listCheckpointRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query",
            "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows",
          ),
        ),
      ),
      loadLatestTurnRows: listLatestTurnRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
            "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
          ),
        ),
      ),
    });

  const getActiveSnapshot: ProjectionSnapshotQueryShape["getActiveSnapshot"] = () =>
    getSnapshotFromQueries({
      operationPrefix: "ProjectionSnapshotQuery.getActiveSnapshot",
      loadProjectRows: listActiveProjectRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveSnapshot:listProjects:query",
            "ProjectionSnapshotQuery.getActiveSnapshot:listProjects:decodeRows",
          ),
        ),
      ),
      loadThreadRows: listActiveThreadRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveSnapshot:listThreads:query",
            "ProjectionSnapshotQuery.getActiveSnapshot:listThreads:decodeRows",
          ),
        ),
      ),
      loadMessageRows: listActiveThreadMessageRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveSnapshot:listThreadMessages:query",
            "ProjectionSnapshotQuery.getActiveSnapshot:listThreadMessages:decodeRows",
          ),
        ),
      ),
      loadProposedPlanRows: listActiveThreadProposedPlanRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveSnapshot:listThreadProposedPlans:query",
            "ProjectionSnapshotQuery.getActiveSnapshot:listThreadProposedPlans:decodeRows",
          ),
        ),
      ),
      loadActivityRows: listActiveThreadActivityRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveSnapshot:listThreadActivities:query",
            "ProjectionSnapshotQuery.getActiveSnapshot:listThreadActivities:decodeRows",
          ),
        ),
      ),
      loadSessionRows: listActiveThreadSessionRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveSnapshot:listThreadSessions:query",
            "ProjectionSnapshotQuery.getActiveSnapshot:listThreadSessions:decodeRows",
          ),
        ),
      ),
      loadCheckpointRows: listActiveCheckpointRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveSnapshot:listCheckpoints:query",
            "ProjectionSnapshotQuery.getActiveSnapshot:listCheckpoints:decodeRows",
          ),
        ),
      ),
      loadLatestTurnRows: listActiveLatestTurnRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveSnapshot:listLatestTurns:query",
            "ProjectionSnapshotQuery.getActiveSnapshot:listLatestTurns:decodeRows",
          ),
        ),
      ),
    });

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

  const listArchivedThreads: ProjectionSnapshotQueryShape["listArchivedThreads"] = () =>
    listArchivedThreadSummaryRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.listArchivedThreads:query",
          "ProjectionSnapshotQuery.listArchivedThreads:decodeRows",
        ),
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
        Effect.map(
          Option.map(
            (row): OrchestrationProject => ({
              id: row.projectId,
              title: row.title,
              workspaceRoot: row.workspaceRoot,
              defaultModelSelection: row.defaultModelSelection,
              scripts: row.scripts,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              deletedAt: row.deletedAt,
            }),
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
            assistantMessageId: row.assistantMessageId,
            completedAt: row.completedAt,
          }),
        ),
      });
    });

  return {
    getSnapshot,
    getActiveSnapshot,
    getCounts,
    listArchivedThreads,
    getActiveProjectByWorkspaceRoot,
    getFirstActiveThreadIdByProjectId,
    getThreadCheckpointContext,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
);
