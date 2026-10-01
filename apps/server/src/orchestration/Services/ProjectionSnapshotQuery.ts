/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  OrchestrationCheckpointSummary,
  OrchestrationGetSnapshotError,
  OrchestrationGetThreadActivitiesInput,
  OrchestrationGetThreadActivitiesResult,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadShell,
  OrchestrationReadThreadInput,
  OrchestrationReadThreadInputError,
  OrchestrationReadThreadResult,
  OrchestrationSearchTranscriptResult,
  ProjectId,
  ThreadId,
  WorkspaceBinding,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Option } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface ProjectionThreadCheckpointContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly workspaceBinding?: WorkspaceBinding | null;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

export interface ProjectionThreadShellProjectContext {
  readonly thread: OrchestrationThreadShell;
  readonly project: Pick<OrchestrationProjectShell, "title"> | null;
}

export interface ProjectionThreadDetailSnapshot {
  readonly snapshotSequence: number;
  readonly thread: OrchestrationThread;
}

export type ProjectionChatArchiveMessage = Pick<
  OrchestrationThread["messages"][number],
  "role" | "text" | "attachments" | "turnId" | "createdAt" | "updatedAt"
>;

export type ProjectionChatArchiveThread = Pick<
  OrchestrationThread,
  | "id"
  | "parentThreadId"
  | "title"
  | "modelSelection"
  | "runtimeMode"
  | "interactionMode"
  | "createdAt"
  | "updatedAt"
> & {
  readonly messages: ReadonlyArray<ProjectionChatArchiveMessage>;
};

export interface ProjectionChatArchiveEntry {
  readonly thread: ProjectionChatArchiveThread;
  readonly project: Pick<OrchestrationProjectShell, "title" | "workspaceRoot">;
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  readonly readThread: (
    input: OrchestrationReadThreadInput,
  ) => Effect.Effect<
    OrchestrationReadThreadResult,
    OrchestrationReadThreadInputError | OrchestrationGetSnapshotError
  >;
  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read the latest orchestration shell snapshot.
   *
   * Returns only projects and thread shell summaries so clients can bootstrap
   * lightweight navigation state without hydrating every thread body.
   */
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read all active chats and their complete message history in one consistent
   * transaction for portable archive export.
   */
  readonly getActiveChatArchiveEntries: () => Effect.Effect<
    ReadonlyArray<ProjectionChatArchiveEntry>,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest sequence applied by every projector without hydrating a
   * snapshot.
   */
  readonly getSnapshotSequence: () => Effect.Effect<number, ProjectionRepositoryError>;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /**
   * Read the active project for an exact workspace root match.
   */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

  /**
   * Read a single active project shell row by id.
   */
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a project.
   */
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read the checkpoint context needed to resolve a single thread diff.
   */
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;

  /**
   * Read a single active thread shell row by id.
   */
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * Read a thread shell and the project data needed for agent awareness in one query wave.
   */
  readonly getThreadShellProjectContextById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadShellProjectContext>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id.
   *
   * Message hydration is capped to the newest `MAX_THREAD_MESSAGES` window
   * (shared with the live projector) so pathological threads cannot blow the
   * heap during decode. Pass `{ unboundedMessages: true }` only for full-
   * history reads such as chat exports.
   */
  readonly getThreadDetailById: (
    threadId: ThreadId,
    options?: {
      readonly unboundedMessages?: boolean;
    },
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;
  readonly getThreadDetailSnapshotById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadDetailSnapshot>, ProjectionRepositoryError>;
  readonly getThreadActivitiesPage: (
    input: OrchestrationGetThreadActivitiesInput,
  ) => Effect.Effect<OrchestrationGetThreadActivitiesResult, ProjectionRepositoryError>;
  readonly searchTranscript?: (
    query: string,
    threadIds?: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<OrchestrationSearchTranscriptResult, ProjectionRepositoryError>;
  /**
   * Batch-resolve owning projects for live threads in a single narrow query.
   *
   * Used by search enrichment, which needs only the project id per match:
   * hydrating full thread details (messages, activities, plans, turns) per
   * match costs ~9 heavy queries each and decodes payloads the caller
   * discards. Soft-deleted threads are excluded, matching
   * `getThreadDetailById` filtering; unknown ids are simply absent.
   */
  readonly listThreadProjectIds: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ReadonlyMap<ThreadId, ProjectId>, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("t3/orchestration/Services/ProjectionSnapshotQuery") {}
