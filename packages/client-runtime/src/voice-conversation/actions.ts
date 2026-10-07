import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
} from "@t3tools/contracts";
import type { VoiceAction } from "@t3tools/client-runtime/voice-conversation";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { AsyncResult } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";
import type { EnvironmentProject, EnvironmentThreadShell } from "../state/shell.ts";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import type { createServerEnvironmentAtoms } from "../state/server.ts";
import type { createProjectEnvironmentAtoms } from "../state/projects.ts";
import type { createThreadEnvironmentAtoms } from "../state/threads.ts";

export function voiceResult<A, E>(result: AtomCommandResult<A, E>): A {
  if (AsyncResult.isSuccess(result)) return result.value;
  if (AsyncResult.isFailure(result)) {
    const failure = squashAtomCommandFailure(result);
    throw failure instanceof Error ? failure : new Error(String(failure));
  }
  throw new Error("Application action did not finish.");
}
export function createVoiceActionBindings<R, ER>(deps: {
  connectionAtomRuntime: Parameters<
    typeof createEnvironmentRpcCommand<R, ER, typeof WS_METHODS.serverCreateVoiceSession>
  >[0];
  appAtomRegistry: AtomRegistry.AtomRegistry;
  serverEnvironment: ReturnType<typeof createServerEnvironmentAtoms>;
  projectEnvironment: ReturnType<typeof createProjectEnvironmentAtoms>;
  threadEnvironment: ReturnType<typeof createThreadEnvironmentAtoms>;
  randomUUID: () => string;
  readProjects: () => readonly EnvironmentProject[];
  readThreadShells: () => readonly EnvironmentThreadShell[];
  readThreadShell: (ref: ScopedThreadRef) => EnvironmentThreadShell | null;
  waitForProject: (ref: ScopedProjectRef) => Promise<EnvironmentProject | null>;
  waitForThreadShell: (ref: ScopedThreadRef) => Promise<boolean>;
}) {
  const {
    connectionAtomRuntime,
    appAtomRegistry,
    serverEnvironment,
    projectEnvironment,
    threadEnvironment,
    randomUUID,
    readProjects,
    readThreadShells,
    readThreadShell,
    waitForProject,
    waitForThreadShell,
  } = deps;
  const createVoiceSessionCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "voice:create-session",
    tag: WS_METHODS.serverCreateVoiceSession,
  });
  const launchThread = createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "voice:launch-thread",
    tag: ORCHESTRATION_V2_WS_METHODS.launchThread,
  });
  const readProjection = createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "voice:read-thread",
    tag: ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
  });
  const readArchived = createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "voice:archived-threads",
    tag: ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
  });
  function createVoiceActions(
    environmentId: EnvironmentId,
    openThread: (threadId: ThreadId) => Promise<void>,
    focusedThread: () => string | null = () => null,
  ) {
    const createdThreads = new Map<ThreadId, Parameters<typeof readThreadShell>[0]>();
    return async (action: VoiceAction): Promise<unknown> => {
      const projects = readProjects().filter((project) => project.environmentId === environmentId);
      switch (action.action) {
        case "get_context":
          return { environmentId, currentThreadId: focusedThread() };
        case "list_projects":
          return projects.map(({ id, title, workspaceRoot }) => ({ id, title, workspaceRoot }));
        case "list_threads": {
          const threads = readThreadShells().filter(
            (thread) =>
              thread.environmentId === environmentId &&
              (!action.projectId || thread.projectId === action.projectId) &&
              (!action.query || thread.title.toLowerCase().includes(action.query.toLowerCase())),
          );
          const archived = voiceResult(
            await runAtomCommand(appAtomRegistry, readArchived, { environmentId, input: {} }),
          );
          return {
            totalActiveMatches: threads.length,
            archived: archived.threads
              .filter(
                (thread) =>
                  (!action.projectId || thread.projectId === action.projectId) &&
                  (!action.query ||
                    thread.title.toLowerCase().includes(action.query.toLowerCase())),
              )
              .slice(0, 100)
              .map((thread) => ({
                id: thread.id,
                projectId: thread.projectId,
                title: thread.title,
              })),
            active: threads.slice(0, 100).map((thread) => ({
              id: thread.id,
              projectId: thread.projectId,
              title: thread.title,
              status: thread.runtime?.status ?? "idle",
              error: thread.runtime?.lastError,
              settled: thread.settledOverride,
              archived: thread.archivedAt !== null,
              needsApproval: thread.hasPendingApprovals,
              needsInput: thread.hasPendingUserInput,
            })),
          };
        }
        case "create_project": {
          const result = voiceResult(
            await runAtomCommand(appAtomRegistry, projectEnvironment.createNew, {
              environmentId,
              input: { name: action.name },
            }),
          );
          await waitForProject(scopeProjectRef(environmentId, result.projectId));
          return result;
        }
        case "add_project": {
          const projectId = ProjectId.make(randomUUID());
          voiceResult(
            await runAtomCommand(appAtomRegistry, projectEnvironment.create, {
              environmentId,
              input: {
                projectId,
                title: action.name,
                workspaceRoot: action.path,
                createWorkspaceRootIfMissing: false,
              },
            }),
          );
          await waitForProject(scopeProjectRef(environmentId, projectId));
          return { projectId };
        }
        case "create_thread": {
          const project = projects.find((candidate) => candidate.id === action.projectId);
          if (!project)
            throw new Error("Project not found in this environment. List projects first.");
          const settings = appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId));
          if (!settings) throw new Error("Environment settings are not loaded.");
          const effective = resolveProjectSettings(settings, project.id, project).settings;
          const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
          const provider = config?.providers.find(
            (entry) =>
              entry.enabled &&
              entry.installed &&
              entry.availability !== "unavailable" &&
              entry.models.length > 0,
          );
          const model = provider?.models.find((entry) => entry.isDefault) ?? provider?.models[0];
          const modelSelection =
            effective.defaultModelSelection ??
            (provider && model ? { instanceId: provider.instanceId, model: model.slug } : null);
          if (!modelSelection)
            throw new Error(
              "Configure a default coding model in Settings before creating a voice thread.",
            );
          const threadId = ThreadId.make(randomUUID());
          voiceResult(
            await runAtomCommand(appAtomRegistry, launchThread, {
              environmentId,
              input: {
                commandId: CommandId.make(randomUUID()),
                threadId,
                projectId: project.id,
                title: action.title,
                modelSelection,
                runtimeMode: effective.defaultRuntimeMode,
                interactionMode: "default",
                workspaceStrategy:
                  effective.defaultThreadEnvMode === "worktree"
                    ? { type: "worktree", baseRef: "HEAD", startFromOrigin: false }
                    : { type: "root" },
              },
            }),
          );
          const ref = scopeThreadRef(environmentId, threadId);
          createdThreads.set(threadId, ref);
          if (!(await waitForThreadShell(ref)))
            throw new Error(
              `Thread ${threadId} was created but has not appeared in the UI yet. Do not create it again.`,
            );
          await openThread(threadId);
          return { threadId };
        }
      }
      const threadId = ThreadId.make(action.threadId);
      const ref = scopeThreadRef(environmentId, threadId);
      let thread = readThreadShell(ref);
      if (!thread && action.action === "unarchive_thread") {
        const archived = voiceResult(
          await runAtomCommand(appAtomRegistry, readArchived, { environmentId, input: {} }),
        );
        if (!archived.threads.some((entry) => entry.id === threadId))
          throw new Error("Archived thread not found.");
      } else if (!thread) {
        if (createdThreads.has(threadId)) {
          await waitForThreadShell(ref);
          thread = readThreadShell(ref);
        }
        if (!thread) throw new Error("Thread not found in this environment. List threads first.");
      }
      switch (action.action) {
        case "open_thread":
          await openThread(threadId);
          return { opened: threadId };
        case "read_thread": {
          const projection = voiceResult(
            await runAtomCommand(appAtomRegistry, readProjection, {
              environmentId,
              input: { threadId },
            }),
          );
          return {
            title: projection.thread.title,
            messages: projection.messages
              .slice(-12)
              .map((message) => ({ role: message.role, text: message.text.slice(0, 6000) })),
            error: thread?.runtime?.lastError,
            needsApproval: thread?.hasPendingApprovals,
            needsInput: thread?.hasPendingUserInput,
          };
        }
        case "send_message": {
          if (!thread || thread.archivedAt)
            throw new Error("Restore this thread before sending a message.");
          voiceResult(
            await runAtomCommand(appAtomRegistry, threadEnvironment.startTurn, {
              environmentId,
              input: {
                threadId,
                message: {
                  messageId: MessageId.make(randomUUID()),
                  role: "user",
                  text: action.message,
                  attachments: [],
                },
                runtimeMode: thread.runtimeMode,
                interactionMode: thread.interactionMode,
                dispatchMode: "queue",
              },
            }),
          );
          return { accepted: true, threadId };
        }
        case "settle_thread":
          voiceResult(
            await runAtomCommand(appAtomRegistry, threadEnvironment.settle, {
              environmentId,
              input: { threadId },
            }),
          );
          break;
        case "unsettle_thread":
          voiceResult(
            await runAtomCommand(appAtomRegistry, threadEnvironment.unsettle, {
              environmentId,
              input: { threadId, reason: "user" },
            }),
          );
          break;
        case "archive_thread":
          if (!threadRuntimeCanArchive(thread?.runtime))
            throw new Error("This agent is active. Ask whether to interrupt it before archiving.");
          voiceResult(
            await runAtomCommand(appAtomRegistry, threadEnvironment.archive, {
              environmentId,
              input: { threadId },
            }),
          );
          break;
        case "unarchive_thread":
          voiceResult(
            await runAtomCommand(appAtomRegistry, threadEnvironment.unarchive, {
              environmentId,
              input: { threadId },
            }),
          );
          break;
        case "interrupt_thread":
          voiceResult(
            await runAtomCommand(appAtomRegistry, threadEnvironment.interruptTurn, {
              environmentId,
              input: { threadId },
            }),
          );
          break;
      }
      return { completed: action.action, threadId };
    };
  }

  return { createVoiceActions, createVoiceSessionCommand };
}
