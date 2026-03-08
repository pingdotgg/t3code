import type { OrchestrationReadModel, ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect, type Path } from "effect";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { WorkspaceRuntimeRouterError } from "../Services/WorkspaceRuntimeRouter.ts";

export interface ResolvedWorkspaceProject {
  readonly id: ProjectId;
  readonly workspaceRoot: string;
  readonly executionTarget: "local" | "ssh-remote";
  readonly remoteHostId: string | null;
}

type ReadModelProject = OrchestrationReadModel["projects"][number];
type ReadModelThread = OrchestrationReadModel["threads"][number];

export interface ResolvedWorkspaceThread {
  readonly thread: ReadModelThread;
  readonly project: ReadModelProject;
}

export function toWorkspaceRuntimeRouterError(
  operation: string,
  cause: unknown,
): WorkspaceRuntimeRouterError {
  return new WorkspaceRuntimeRouterError({ operation, cause });
}

export function remoteAdapterKey(remoteHostId: string, provider: string): string {
  return `ssh-remote:${remoteHostId}:${provider}`;
}

export function makeWorkspaceRuntimeRoutingSupport(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly path: Path.Path;
}) {
  const resolveProject = Effect.fn("WorkspaceRuntimeRouter.resolveProject")(function* (
    projectId: ProjectId,
  ) {
    const readModel = yield* input.orchestrationEngine.getReadModel();
    const project = readModel.projects.find((entry) => entry.id === projectId && entry.deletedAt === null);
    if (!project) {
      return yield* Effect.die(new Error(`Project '${projectId}' not found.`));
    }
    return {
      id: project.id,
      workspaceRoot: project.workspaceRoot,
      executionTarget: project.executionTarget ?? "local",
      remoteHostId: project.remoteHostId ?? null,
    } satisfies ResolvedWorkspaceProject;
  });

  const resolveThread = Effect.fn("WorkspaceRuntimeRouter.resolveThread")(function* (
    threadId: ThreadId,
  ) {
    const readModel = yield* input.orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId && entry.deletedAt === null);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' not found.`));
    }
    const project = readModel.projects.find(
      (entry) => entry.id === thread.projectId && entry.deletedAt === null,
    );
    if (!project) {
      return yield* Effect.die(new Error(`Project '${thread.projectId}' not found for thread '${threadId}'.`));
    }
    return { thread, project } satisfies ResolvedWorkspaceThread;
  });

  const resolveGitCwd = (inputValue: {
    readonly projectId?: ProjectId | undefined;
    readonly cwd?: string | undefined;
  }) =>
    inputValue.projectId
      ? resolveProject(inputValue.projectId).pipe(
          Effect.map((project) => inputValue.cwd?.trim() || project.workspaceRoot),
        )
      : Effect.succeed(inputValue.cwd?.trim() || process.cwd());

  const resolveWorkspaceWritePath = (workspaceRoot: string, relativePath: string) =>
    Effect.gen(function* () {
      const normalizedInputPath = relativePath.trim();
      if (input.path.isAbsolute(normalizedInputPath)) {
        return yield* Effect.die(new Error("Workspace file path must be relative to the project root."));
      }
      const absolutePath = input.path.resolve(workspaceRoot, normalizedInputPath);
      const relativeToRoot = input.path.relative(workspaceRoot, absolutePath).replaceAll("\\", "/");
      if (
        relativeToRoot.length === 0 ||
        relativeToRoot === "." ||
        relativeToRoot === ".." ||
        relativeToRoot.startsWith("../") ||
        input.path.isAbsolute(relativeToRoot)
      ) {
        return yield* Effect.die(new Error("Workspace file path must stay within the project root."));
      }
      return { absolutePath, relativePath: relativeToRoot } as const;
    });

  const routeProject = <TLocal, TRemote, ELocal, ERemote>(routeInput: {
    readonly projectId?: ProjectId | undefined;
    readonly cwd?: string | undefined;
    readonly local: (
      project: ResolvedWorkspaceProject,
    ) => Effect.Effect<TLocal, ELocal, never>;
    readonly remote: (
      project: ResolvedWorkspaceProject,
      remoteHostId: string,
    ) => Effect.Effect<TRemote, ERemote, never>;
  }) =>
    (routeInput.projectId
      ? resolveProject(routeInput.projectId)
      : Effect.succeed({
          id: "__local__" as ProjectId,
          workspaceRoot: routeInput.cwd ?? process.cwd(),
          executionTarget: "local" as const,
          remoteHostId: null,
        }))
      .pipe(
        Effect.flatMap((project): Effect.Effect<TLocal | TRemote, ELocal | ERemote, never> => {
          if (project.executionTarget === "ssh-remote") {
            if (!project.remoteHostId) {
              return Effect.die(new Error(`Remote project '${project.id}' is missing a remote host binding.`));
            }
            return routeInput.remote(project, project.remoteHostId);
          }
          return routeInput.local(project);
        }),
        Effect.mapError((cause) => toWorkspaceRuntimeRouterError("routeProject", cause)),
      );

  const routeThread = <TLocal, TRemote, ELocal, ERemote>(routeInput: {
    readonly threadId: ThreadId;
    readonly local: (
      resolved: ResolvedWorkspaceThread,
    ) => Effect.Effect<TLocal, ELocal, never>;
    readonly remote: (
      resolved: ResolvedWorkspaceThread,
      remoteHostId: string,
    ) => Effect.Effect<TRemote, ERemote, never>;
  }) =>
    resolveThread(routeInput.threadId).pipe(
      Effect.flatMap((resolved): Effect.Effect<TLocal | TRemote, ELocal | ERemote, never> => {
        if (resolved.project.executionTarget === "ssh-remote") {
          if (!resolved.project.remoteHostId) {
            return Effect.die(
              new Error(`Remote project '${resolved.project.id}' is missing a remote host binding.`),
            );
          }
          return routeInput.remote(resolved, resolved.project.remoteHostId);
        }
        return routeInput.local(resolved);
      }),
      Effect.mapError((cause) => toWorkspaceRuntimeRouterError("routeThread", cause)),
    );

  return {
    resolveProject,
    resolveThread,
    resolveGitCwd,
    resolveWorkspaceWritePath,
    routeProject,
    routeThread,
  };
}
