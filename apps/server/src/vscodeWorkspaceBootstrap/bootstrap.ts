// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type DesktopBootstrapWorkspaceFolder as DesktopBootstrapWorkspaceFolderValue,
  ProjectId,
  ProviderInstanceId,
  type ServerLifecycleBootstrapProject as ServerLifecycleBootstrapProjectValue,
  ThreadId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export class VscodeWorkspaceBootstrapError extends Data.TaggedError(
  "VscodeWorkspaceBootstrapError",
)<{
  readonly message: string;
  readonly status?: 400 | 401 | 403 | 500;
  readonly cause?: unknown;
}> {}

const DEFAULT_MODEL_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: DEFAULT_MODEL,
};

export const bootstrapVscodeWorkspaces = Effect.fn("bootstrapVscodeWorkspaces")(function* (input: {
  readonly workspaceFolders: readonly DesktopBootstrapWorkspaceFolderValue[];
  readonly activeWorkspaceFolderKey?: string | undefined;
}) {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const serverEnvironment = yield* ServerEnvironment;
  const environment = yield* serverEnvironment.getDescriptor;
  const shellSnapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
    Effect.mapError(
      (cause) =>
        new VscodeWorkspaceBootstrapError({
          message: "Failed to load desktop workspace shell snapshot.",
          status: 500,
          cause,
        }),
    ),
  );
  const projects: OrchestrationProjectShell[] = [...shellSnapshot.projects];
  const threads: OrchestrationThreadShell[] = [...shellSnapshot.threads];
  const bootstrapProjects: ServerLifecycleBootstrapProjectValue[] = [];
  const workspaceFolderKeys = new Set(input.workspaceFolders.map((folder) => folder.key));
  const activeWorkspaceKey =
    input.activeWorkspaceFolderKey && workspaceFolderKeys.has(input.activeWorkspaceFolderKey)
      ? input.activeWorkspaceFolderKey
      : input.workspaceFolders[0]?.key;
  const latestActiveThreadByProject = collectLatestActiveThreadsByProject(threads);

  for (const folder of input.workspaceFolders) {
    const title = folder.name || resolveWorkspaceName(folder.cwd);
    let project = projects.find((candidate) =>
      workspaceRootsEqual(candidate.workspaceRoot, folder.cwd),
    );

    if (!project) {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const createdProject: OrchestrationProjectShell = {
        id: ProjectId.make(yield* randomUUID),
        title,
        workspaceRoot: folder.cwd,
        repositoryIdentity: null,
        defaultModelSelection: DEFAULT_MODEL_SELECTION,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
      };
      yield* orchestrationEngine
        .dispatch({
          type: "project.create",
          commandId: CommandId.make(yield* randomUUID),
          projectId: createdProject.id,
          title,
          workspaceRoot: folder.cwd,
          defaultModelSelection: DEFAULT_MODEL_SELECTION,
          createdAt,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new VscodeWorkspaceBootstrapError({
                message: "Failed to create VS Code workspace project.",
                status: 500,
                cause,
              }),
          ),
        );
      projects.push(createdProject);
      project = createdProject;
    }

    let thread = latestActiveThreadByProject.get(project.id) ?? null;
    if (!thread) {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      thread = {
        id: ThreadId.make(yield* randomUUID),
        projectId: project.id,
        title: "New thread",
        modelSelection: project.defaultModelSelection ?? DEFAULT_MODEL_SELECTION,
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      };
      yield* orchestrationEngine
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make(yield* randomUUID),
          threadId: thread.id,
          projectId: project.id,
          title: "New thread",
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          branch: null,
          worktreePath: null,
          createdAt,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new VscodeWorkspaceBootstrapError({
                message: "Failed to create VS Code workspace thread.",
                status: 500,
                cause,
              }),
          ),
        );
      threads.push(thread);
      latestActiveThreadByProject.set(project.id, thread);
    }

    bootstrapProjects.push({
      workspaceFolderKey: folder.key,
      workspaceFolderName: folder.name,
      cwd: folder.cwd,
      projectId: project.id,
      bootstrapThreadId: thread.id,
      isActive: folder.key === activeWorkspaceKey,
    });
  }

  return {
    environmentId: environment.environmentId,
    bootstrapProjects,
  };
});

function collectLatestActiveThreadsByProject(
  threads: readonly OrchestrationThreadShell[],
): Map<ProjectId, OrchestrationThreadShell> {
  const latestByProject = new Map<ProjectId, OrchestrationThreadShell>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) {
      continue;
    }
    const current = latestByProject.get(thread.projectId);
    if (!current || compareThreadsByLatestActivity(thread, current) > 0) {
      latestByProject.set(thread.projectId, thread);
    }
  }
  return latestByProject;
}

function compareThreadsByLatestActivity(
  left: OrchestrationThreadShell,
  right: OrchestrationThreadShell,
): number {
  const leftTimestamp = sortableThreadTimestamp(left);
  const rightTimestamp = sortableThreadTimestamp(right);
  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }
  return left.id.localeCompare(right.id);
}

function sortableThreadTimestamp(thread: OrchestrationThreadShell): number {
  return (
    toSortableTimestamp(thread.latestUserMessageAt) ??
    toSortableTimestamp(thread.updatedAt) ??
    toSortableTimestamp(thread.createdAt) ??
    Number.NEGATIVE_INFINITY
  );
}

function toSortableTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function workspaceRootsEqual(left: string, right: string): boolean {
  return normalizeWorkspaceRootForMatch(left) === normalizeWorkspaceRootForMatch(right);
}

function normalizeWorkspaceRootForMatch(value: string): string {
  const normalized = NodePath.normalize(value.trim()).replace(/[\\/]+$/u, "");
  return Effect.runSync(HostProcessPlatform) === "win32" ? normalized.toLowerCase() : normalized;
}

function resolveWorkspaceName(cwd: string): string {
  return cwd.split(/[/\\]/).findLast((segment) => segment.length > 0) || "project";
}
