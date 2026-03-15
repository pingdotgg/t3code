import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, Path, Scope, ServiceMap } from "effect";

import { ServerConfig } from "./config";
import { Keybindings } from "./keybindings";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";

export interface ServerBootstrapStateShape {
  readonly cwd: string;
  readonly projectName: string;
  readonly bootstrapProjectId?: ProjectId;
  readonly bootstrapThreadId?: ThreadId;
}

export interface ServerRuntimeStateShape {
  readonly bootstrapState: ServerBootstrapStateShape;
}

export class ServerRuntimeState extends ServiceMap.Service<
  ServerRuntimeState,
  ServerRuntimeStateShape
>()("t3/serverRuntime/ServerRuntimeState") {}

const resolveBootstrapState = Effect.fn(function* () {
  const serverConfig = yield* ServerConfig;
  const path = yield* Path.Path;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const projectName = path.basename(serverConfig.cwd) || "project";
  let bootstrapProjectId: ProjectId | undefined;
  let bootstrapThreadId: ThreadId | undefined;

  if (serverConfig.autoBootstrapProjectFromCwd) {
    const snapshot = yield* projectionSnapshotQuery.getSnapshot();
    const existingProject = snapshot.projects.find(
      (project) => project.workspaceRoot === serverConfig.cwd && project.deletedAt === null,
    );
    let projectId: ProjectId;
    let defaultModel: string;

    if (!existingProject) {
      const createdAt = new Date().toISOString();
      projectId = ProjectId.makeUnsafe(crypto.randomUUID());
      defaultModel = "gpt-5-codex";
      yield* orchestrationEngine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        projectId,
        title: projectName,
        workspaceRoot: serverConfig.cwd,
        defaultModel,
        createdAt,
      });
    } else {
      projectId = existingProject.id;
      defaultModel = existingProject.defaultModel ?? "gpt-5-codex";
    }

    const refreshedSnapshot = existingProject
      ? snapshot
      : yield* projectionSnapshotQuery.getSnapshot();
    const existingThread = refreshedSnapshot.threads.find(
      (thread) => thread.projectId === projectId && thread.deletedAt === null,
    );

    if (!existingThread) {
      const createdAt = new Date().toISOString();
      const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId,
        projectId,
        title: "New thread",
        model: defaultModel,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      bootstrapProjectId = projectId;
      bootstrapThreadId = threadId;
    } else {
      bootstrapProjectId = projectId;
      bootstrapThreadId = existingThread.id;
    }
  }

  return {
    cwd: serverConfig.cwd,
    projectName,
    ...(bootstrapProjectId ? { bootstrapProjectId } : {}),
    ...(bootstrapThreadId ? { bootstrapThreadId } : {}),
  } satisfies ServerBootstrapStateShape;
});

export const ServerRuntimeStateLive = Layer.effect(
  ServerRuntimeState,
  Effect.gen(function* () {
    const keybindingsManager = yield* Keybindings;
    const orchestrationReactor = yield* OrchestrationReactor;

    yield* keybindingsManager.syncDefaultKeybindingsOnStartup.pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to sync keybindings defaults on startup", {
          path: error.configPath,
          detail: error.detail,
          cause: error.cause,
        }),
      ),
    );

    const startupScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(startupScope, Exit.void));
    yield* Scope.provide(orchestrationReactor.start, startupScope);

    return {
      bootstrapState: yield* resolveBootstrapState(),
    } satisfies ServerRuntimeStateShape;
  }),
);
