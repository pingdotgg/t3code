import { type OrchestrationReadModel } from "@t3tools/contracts";
import { Effect, Exit, Option } from "effect";
import { WorkspacePaths } from "../workspace/Services/WorkspacePaths.ts";
import {
  getLiveOrchestrationSnapshot,
  withLiveOrchestrationClient,
  withLiveSnapshotAndRpc,
  type CliLiveOrchestrationClient,
  type CliLiveTargetFlags,
  type WsRpcClient,
} from "./client.ts";

export type ActiveProject = OrchestrationReadModel["projects"][number];
export type CliThread = OrchestrationReadModel["threads"][number];

export interface ThreadResolutionOptions {
  // Archived threads are excluded by default so mutating commands never act on a
  // thread the user has put away. Only unarchive/show opt back in.
  readonly includeArchived?: boolean;
}

export const normalizeWorkspaceRootForProjectCommand = Effect.fn(
  "normalizeWorkspaceRootForProjectCommand",
)(function* (workspaceRoot: string) {
  const workspacePaths = yield* WorkspacePaths;
  return yield* workspacePaths.normalizeWorkspaceRoot(workspaceRoot);
});

export const activeProjectsOf = (snapshot: OrchestrationReadModel): ReadonlyArray<ActiveProject> =>
  snapshot.projects.filter((project) => project.deletedAt === null);

export const activeThreadsOf = (snapshot: OrchestrationReadModel): ReadonlyArray<CliThread> =>
  snapshot.threads.filter((thread) => thread.deletedAt === null && thread.archivedAt === null);

export const projectSummary = (project: ActiveProject) => ({
  id: project.id,
  title: project.title,
  workspaceRoot: project.workspaceRoot,
  defaultModelSelection: project.defaultModelSelection,
  scripts: project.scripts,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
});

export const threadSummary = (thread: CliThread) => ({
  id: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  modelSelection: thread.modelSelection,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  latestTurn: thread.latestTurn,
  session: thread.session,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  archivedAt: thread.archivedAt,
});

export const findProjectForCli = Effect.fn("findProjectForCli")(function* (
  snapshot: OrchestrationReadModel,
  identifier: string,
) {
  const trimmed = identifier.trim();
  if (trimmed.length === 0) {
    return yield* Effect.fail(new Error("Project identifier cannot be empty."));
  }

  const activeProjects = activeProjectsOf(snapshot);
  const byId = activeProjects.find((project) => project.id === trimmed);
  if (byId) return byId;

  const normalizedWorkspaceRootResult = yield* Effect.exit(
    normalizeWorkspaceRootForProjectCommand(trimmed),
  );
  const normalizedWorkspaceRoot = Exit.isSuccess(normalizedWorkspaceRootResult)
    ? normalizedWorkspaceRootResult.value
    : null;
  const byWorkspace =
    normalizedWorkspaceRoot === null
      ? undefined
      : activeProjects.find((project) => project.workspaceRoot === normalizedWorkspaceRoot);
  if (byWorkspace) return byWorkspace;

  const byTitle = activeProjects.filter((project) => project.title === trimmed);
  if (byTitle.length === 1) return byTitle[0]!;
  if (byTitle.length > 1) {
    return yield* Effect.fail(
      new Error(`Multiple active projects are named '${trimmed}'. Use the project id instead.`),
    );
  }

  return yield* Effect.fail(new Error(`No active project found for '${trimmed}'.`));
});

export const findThreadForCli = (
  snapshot: OrchestrationReadModel,
  identifier: string,
  options?: ThreadResolutionOptions,
) =>
  Effect.gen(function* () {
    const trimmed = identifier.trim();
    if (trimmed.length === 0) {
      return yield* Effect.fail(new Error("Thread identifier cannot be empty."));
    }

    const includeArchived = options?.includeArchived ?? false;
    const candidates = snapshot.threads.filter(
      (thread) => thread.deletedAt === null && (includeArchived || thread.archivedAt === null),
    );
    const byId = candidates.find((thread) => thread.id === trimmed);
    if (byId) return byId;

    const byTitle = candidates.filter((thread) => thread.title === trimmed);
    if (byTitle.length === 1) return byTitle[0]!;
    if (byTitle.length > 1) {
      return yield* Effect.fail(
        new Error(`Multiple threads are named '${trimmed}'. Use the thread id instead.`),
      );
    }

    if (!includeArchived) {
      const archivedMatch = snapshot.threads.find(
        (thread) =>
          thread.deletedAt === null &&
          thread.archivedAt !== null &&
          (thread.id === trimmed || thread.title === trimmed),
      );
      if (archivedMatch) {
        return yield* Effect.fail(
          new Error(
            `Thread '${trimmed}' is archived. Unarchive it first with 'chat unarchive ${trimmed}'.`,
          ),
        );
      }
    }

    return yield* Effect.fail(new Error(`No thread found for '${trimmed}'.`));
  });

export const resolveThreadForCli = Effect.fn("resolveThreadForCli")(function* (
  flags: CliLiveTargetFlags,
  identifier: string,
  options?: ThreadResolutionOptions,
) {
  const snapshot = yield* getLiveOrchestrationSnapshot(flags);
  return yield* findThreadForCli(snapshot, identifier, options);
});

// Resolve a thread and dispatch HTTP orchestration commands sharing a single
// borrowed bearer token (one auth session + one snapshot fetch per command).
export const withThreadDispatch = <A, E, R>(
  flags: CliLiveTargetFlags,
  identifier: string,
  run: (input: {
    readonly thread: CliThread;
    readonly snapshot: OrchestrationReadModel;
    readonly dispatch: CliLiveOrchestrationClient["dispatch"];
  }) => Effect.Effect<A, E, R>,
  options?: ThreadResolutionOptions,
) =>
  withLiveOrchestrationClient(flags, ({ getSnapshot, dispatch }) =>
    Effect.gen(function* () {
      const snapshot = yield* getSnapshot;
      const thread = yield* findThreadForCli(snapshot, identifier, options);
      return yield* run({ thread, snapshot, dispatch });
    }),
  );

// Resolve a thread and issue WebSocket RPCs sharing a single borrowed bearer
// token (one auth session + one WS connection per command).
export const withThreadRpc = <A, E, R>(
  flags: CliLiveTargetFlags,
  identifier: string,
  run: (input: {
    readonly thread: CliThread;
    readonly snapshot: OrchestrationReadModel;
    readonly client: WsRpcClient;
  }) => Effect.Effect<A, E, R>,
) =>
  withLiveSnapshotAndRpc(flags, ({ getSnapshot, client }) =>
    Effect.gen(function* () {
      const snapshot = yield* getSnapshot;
      const thread = yield* findThreadForCli(snapshot, identifier);
      return yield* run({ thread, snapshot, client });
    }),
  );

// Resolve a project and issue WebSocket RPCs sharing a single borrowed token.
export const withProjectRpc = <A, E, R>(
  flags: CliLiveTargetFlags,
  identifier: string,
  run: (input: {
    readonly project: ActiveProject;
    readonly snapshot: OrchestrationReadModel;
    readonly client: WsRpcClient;
  }) => Effect.Effect<A, E, R>,
) =>
  withLiveSnapshotAndRpc(flags, ({ getSnapshot, client }) =>
    Effect.gen(function* () {
      const snapshot = yield* getSnapshot;
      const project = yield* findProjectForCli(snapshot, identifier);
      return yield* run({ project, snapshot, client });
    }),
  );

// Resolve a thread plus its project and issue WebSocket RPCs sharing one token.
export const withTerminalRpc = <A, E, R>(
  flags: CliLiveTargetFlags,
  chat: string,
  run: (input: {
    readonly thread: CliThread;
    readonly project: ActiveProject;
    readonly client: WsRpcClient;
  }) => Effect.Effect<A, E, R>,
) =>
  withLiveSnapshotAndRpc(flags, ({ getSnapshot, client }) =>
    Effect.gen(function* () {
      const snapshot = yield* getSnapshot;
      const thread = yield* findThreadForCli(snapshot, chat);
      const project = snapshot.projects.find((candidate) => candidate.id === thread.projectId);
      if (!project) {
        return yield* Effect.fail(new Error(`Project '${thread.projectId}' not found.`));
      }
      return yield* run({ thread, project, client });
    }),
  );
