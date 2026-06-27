import { CommandId, type ThreadId as ThreadIdType } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { GitWorkflowService } from "./git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectSetupScriptRunner } from "./project/ProjectSetupScriptRunner.ts";
import { SourceControlProviderRegistry } from "./sourceControl/SourceControlProviderRegistry.ts";
import {
  T3workToolBroker,
  type T3workToolBrokerShape,
  type T3workTurnToolContext,
} from "./t3work-toolBroker.ts";
import {
  createT3workPrelaunchToolBinding,
  createT3workThreadToolBinding,
} from "./t3work-toolBrokerBinding.ts";
import { t3workRandomUUID } from "./t3work-random.ts";
import { buildPrelaunchView } from "./t3work-toolBrokerPrelaunchView.ts";
import { makeStartChildThread } from "./t3work-toolBrokerStartChild.ts";
import { T3workThreadToolContextStore } from "./t3work-threadToolContextStore.ts";
import { buildThreadWorkspaceView } from "./t3work-toolBrokerViewWorkspace.ts";

const createT3workToolBroker = Effect.fn("createT3workToolBroker")(function* () {
  const query = yield* ProjectionSnapshotQuery;
  const orchestration = yield* OrchestrationEngineService;
  const contextStore = yield* T3workThreadToolContextStore;
  const fileSystem = Option.getOrUndefined(yield* Effect.serviceOption(FileSystem.FileSystem));
  const path = Option.getOrUndefined(yield* Effect.serviceOption(Path.Path));
  const gitWorkflow = Option.getOrUndefined(yield* Effect.serviceOption(GitWorkflowService));
  const sourceControlProviders = Option.getOrUndefined(
    yield* Effect.serviceOption(SourceControlProviderRegistry),
  );
  const projectSetupScriptRunner = Option.getOrUndefined(
    yield* Effect.serviceOption(ProjectSetupScriptRunner),
  );

  const loadThreadProject = (threadId: ThreadIdType) =>
    Effect.gen(function* () {
      const thread = Option.getOrUndefined(yield* query.getThreadDetailById(threadId));
      if (!thread) return yield* Effect.fail("Current t3work thread was not found.");

      const project = Option.getOrUndefined(yield* query.getProjectShellById(thread.projectId));
      if (!project) {
        return yield* Effect.fail("Current t3work project was not found.");
      }

      return { project, thread };
    });

  const loadThreadView = (threadId: ThreadIdType, toolContext: T3workTurnToolContext) =>
    Effect.gen(function* () {
      const resolved = yield* loadThreadProject(threadId).pipe(Effect.option);
      const thread = Option.isSome(resolved) ? resolved.value.thread : undefined;
      const project = Option.isSome(resolved) ? resolved.value.project : undefined;
      return {
        surface: toolContext.surface,
        state: toolContext.state,
        project: project
          ? {
              id: project.id,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
            }
          : null,
        thread: thread
          ? {
              id: thread.id,
              projectId: thread.projectId,
              title: thread.title,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              messageCount: thread.messages.length,
              latestTurnId: thread.latestTurn?.turnId ?? null,
              ...buildThreadWorkspaceView({ thread, project }),
            }
          : null,
      };
    });

  const setBacklogAssigneeFilter = (toolContext: T3workTurnToolContext, mode: "current-user") =>
    Effect.gen(function* () {
      if (mode !== "current-user") {
        return yield* Effect.fail("Only the current-user assignee filter mode is supported.");
      }

      if (!toolContext.state || typeof toolContext.state !== "object") {
        return yield* Effect.fail("Backlog view state is not available.");
      }

      const state = toolContext.state as {
        readonly backlog?: {
          readonly state?: {
            readonly assigneeFilter?: unknown;
          };
          readonly currentUserDisplayName?: unknown;
        };
      };
      const currentUserDisplayName =
        typeof state.backlog?.currentUserDisplayName === "string"
          ? state.backlog.currentUserDisplayName.trim()
          : "";

      if (currentUserDisplayName.length === 0) {
        return yield* Effect.fail(
          "Current user display name is unavailable for this backlog view.",
        );
      }

      const currentAssigneeFilter =
        typeof state.backlog?.state?.assigneeFilter === "string"
          ? state.backlog.state.assigneeFilter
          : undefined;
      const alreadyApplied = currentAssigneeFilter === currentUserDisplayName;

      return {
        ok: true,
        applied: !alreadyApplied,
        promptText: alreadyApplied
          ? `The dashboard is already filtered to work assigned to ${currentUserDisplayName}.`
          : `The dashboard is now filtered to work assigned to ${currentUserDisplayName}.`,
        ...(alreadyApplied
          ? {}
          : {
              viewStatePatch: {
                assigneeFilter: currentUserDisplayName,
              },
            }),
      };
    });
  const renameThread = (threadId: ThreadIdType, title: string) =>
    orchestration.dispatch({
      type: "thread.meta.update",
      commandId: CommandId.make(`server:t3work:rename:${t3workRandomUUID()}`),
      threadId,
      title,
    });
  const startChildThread = makeStartChildThread({
    loadThreadProject,
    orchestration,
    contextStore,
    services: {
      ...(fileSystem ? { fileSystem } : {}),
      ...(path ? { path } : {}),
      ...(gitWorkflow ? { gitWorkflow } : {}),
      ...(sourceControlProviders ? { sourceControlProviders } : {}),
      ...(projectSetupScriptRunner ? { projectSetupScriptRunner } : {}),
    },
  });

  const bindSession: T3workToolBrokerShape["bindSession"] = ({
    threadId,
    toolContext,
    allowedToolGroups,
  }) =>
    Effect.gen(function* () {
      if (toolContext !== undefined) {
        yield* contextStore.put({ threadId, toolContext });
      }

      const resolvedToolContext = toolContext ?? (yield* contextStore.get(threadId));
      if (!resolvedToolContext || resolvedToolContext.surface !== "t3work") {
        return undefined;
      }

      const toolIds = Array.from(new Set(resolvedToolContext.tools.map((tool) => tool.id)));
      if (toolIds.length === 0) {
        return undefined;
      }

      return createT3workThreadToolBinding({
        threadId,
        availableToolIds: toolIds,
        allowedToolGroups,
        readView: () => loadThreadView(threadId, resolvedToolContext),
        renameThread: (title) => renameThread(threadId, title),
        renameThreadResult: (title) => ({ ok: true, threadId, title }),
        startChild: (toolArgs) => startChildThread(threadId, toolArgs),
        setBacklogAssigneeFilter: (mode) => setBacklogAssigneeFilter(resolvedToolContext, mode),
      });
    });

  const bindReadOnly: T3workToolBrokerShape["bindReadOnly"] = ({
    workspaceRoot,
    callerKind,
    renderContext,
    allowedToolGroups,
  }) =>
    Effect.succeed(
      createT3workPrelaunchToolBinding({
        workspaceRoot,
        callerKind,
        allowedToolGroups,
        readView: () =>
          Effect.succeed(buildPrelaunchView({ workspaceRoot, callerKind, renderContext })),
      }),
    );

  return { bindSession, bindReadOnly } satisfies T3workToolBrokerShape;
});

export const T3workToolBrokerLive = Layer.effect(T3workToolBroker, createT3workToolBroker());
