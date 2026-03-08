import {
  type CheckpointRef,
  type OpenInEditorInput,
  type ProjectId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path, PubSub, Stream } from "effect";

import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { Open } from "../../open.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { searchWorkspaceEntries } from "../../workspaceEntries.ts";
import {
  REMOTE_HELPER_NOTIFICATION_METHODS,
  REMOTE_HELPER_METHODS,
  type RemoteHelperMethodParams,
} from "../protocol.ts";
import { RemoteHelperClient } from "../Services/HelperClient.ts";
import {
  WorkspaceRuntimeRouter,
  type WorkspaceRuntimeRouterShape,
} from "../Services/WorkspaceRuntimeRouter.ts";
import {
  makeWorkspaceRuntimeRoutingSupport,
  remoteAdapterKey,
  toWorkspaceRuntimeRouterError,
} from "./workspaceRuntimeRouterSupport.ts";

const makeWorkspaceRuntimeRouter = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const terminalManager = yield* TerminalManager;
  const gitManager = yield* GitManager;
  const git = yield* GitCore;
  const checkpointStore = yield* CheckpointStore;
  const helperClient = yield* RemoteHelperClient;
  const { openInEditor } = yield* Open;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providerEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const terminalListeners = new Set<(event: any) => void>();
  const {
    resolveProject,
    resolveGitCwd,
    resolveWorkspaceWritePath,
    routeProject,
    routeThread,
  } = makeWorkspaceRuntimeRoutingSupport({
    orchestrationEngine,
    path,
  });

  const publishProviderEvent = (event: ProviderRuntimeEvent) =>
    PubSub.publish(providerEvents, event).pipe(Effect.asVoid);

  yield* Stream.runForEach(providerService.streamEvents, publishProviderEvent).pipe(
    Effect.forkScoped,
  );

  const unsubscribeLocalTerminal = yield* terminalManager.subscribe((event) => {
    for (const listener of terminalListeners) {
      listener(event);
    }
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeLocalTerminal()));

  const unsubscribeHelperNotifications = yield* helperClient.subscribe((notification) => {
    if (notification.method === REMOTE_HELPER_NOTIFICATION_METHODS.providerEvent) {
      void Effect.runPromise(publishProviderEvent(notification.params as ProviderRuntimeEvent));
      return;
    }
    if (notification.method === REMOTE_HELPER_NOTIFICATION_METHODS.terminalEvent) {
      for (const listener of terminalListeners) {
        listener(notification.params);
      }
    }
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeHelperNotifications()));

  const callRemote = <TMethod extends keyof RemoteHelperMethodParams & string>(
    remoteHostId: string,
    method: TMethod,
    params: RemoteHelperMethodParams[TMethod],
  ) => helperClient.call(remoteHostId as any, method, params);

  const routeProjectGitOperation = <T, ELocal, ERemote>(
    input: {
      readonly projectId?: ProjectId | undefined;
      readonly cwd?: string | undefined;
    },
    handlers: {
      readonly local: (cwd: string) => Effect.Effect<T, ELocal, never>;
      readonly remote: (cwd: string, remoteHostId: string) => Effect.Effect<T, ERemote, never>;
    },
  ) =>
    routeProject({
      projectId: input.projectId,
      cwd: input.cwd,
      local: () => resolveGitCwd(input).pipe(Effect.flatMap((cwd) => handlers.local(cwd))),
      remote: (_project, remoteHostId) =>
        resolveGitCwd(input).pipe(
          Effect.flatMap((cwd) => handlers.remote(cwd, remoteHostId)),
        ),
    });

  const listProviderSessions: WorkspaceRuntimeRouterShape["listProviderSessions"] = () =>
    Effect.gen(function* () {
      const localSessions = yield* providerService.listSessions();
      const readModel = yield* orchestrationEngine.getReadModel();
      const remoteHostIds = [
        ...new Set(
          readModel.projects
            .filter((project) => project.executionTarget === "ssh-remote")
            .flatMap((project) =>
              typeof project.remoteHostId === "string" ? [project.remoteHostId] : [],
            ),
        ),
      ];
      const remoteSessions = yield* Effect.forEach(
        remoteHostIds,
        (remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.providerListSessions, undefined)
            .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<ProviderSession>))),
        { concurrency: "unbounded" },
      );
      return [...localSessions, ...remoteSessions.flat()];
    }).pipe(Effect.mapError((cause) => toWorkspaceRuntimeRouterError("listProviderSessions", cause)));

  const startProviderSession: WorkspaceRuntimeRouterShape["startProviderSession"] = (
    threadId,
    input,
  ) =>
    routeThread({
      threadId,
      local: () => providerService.startSession(threadId, input),
      remote: ({ project }, remoteHostId) =>
        callRemote(remoteHostId, REMOTE_HELPER_METHODS.providerStartSession, input).pipe(
          Effect.tap((session) =>
            providerSessionDirectory.upsert({
              threadId,
              provider: session.provider,
              adapterKey: remoteAdapterKey(remoteHostId, session.provider),
              runtimeMode: session.runtimeMode,
              status: session.status === "error" ? "error" : "running",
              resumeCursor: session.resumeCursor ?? null,
              runtimePayload: {
                cwd: session.cwd ?? project.workspaceRoot,
                remoteHostId,
              },
            }),
          ),
        ),
    });

  const getProviderCapabilities: WorkspaceRuntimeRouterShape["getProviderCapabilities"] = (
    _threadId,
    provider,
  ) =>
    providerService
      .getCapabilities(provider)
      .pipe(Effect.mapError((cause) => toWorkspaceRuntimeRouterError("getProviderCapabilities", cause)));

  const sendProviderTurn: WorkspaceRuntimeRouterShape["sendProviderTurn"] = (input) =>
    routeThread({
      threadId: input.threadId,
      local: () => providerService.sendTurn(input),
      remote: (_resolved, remoteHostId) =>
        callRemote(remoteHostId, REMOTE_HELPER_METHODS.providerSendTurn, input),
    });

  const interruptProviderTurn: WorkspaceRuntimeRouterShape["interruptProviderTurn"] = (input) =>
    routeThread({
      threadId: input.threadId,
      local: () => providerService.interruptTurn(input),
      remote: (_resolved, remoteHostId) =>
        callRemote(remoteHostId, REMOTE_HELPER_METHODS.providerInterruptTurn, input),
    });

  const respondToProviderRequest: WorkspaceRuntimeRouterShape["respondToProviderRequest"] = (
    input,
  ) =>
    routeThread({
      threadId: input.threadId,
      local: () => providerService.respondToRequest(input),
      remote: (_resolved, remoteHostId) =>
        callRemote(remoteHostId, REMOTE_HELPER_METHODS.providerRespondToRequest, input),
    });

  const respondToProviderUserInput: WorkspaceRuntimeRouterShape["respondToProviderUserInput"] = (
    input,
  ) =>
    routeThread({
      threadId: input.threadId,
      local: () => providerService.respondToUserInput(input),
      remote: (_resolved, remoteHostId) =>
        callRemote(remoteHostId, REMOTE_HELPER_METHODS.providerRespondToUserInput, input),
    });

  const stopProviderSession: WorkspaceRuntimeRouterShape["stopProviderSession"] = (threadId) =>
    routeThread({
      threadId,
      local: () => providerService.stopSession({ threadId }),
      remote: (_resolved, remoteHostId) =>
        callRemote(remoteHostId, REMOTE_HELPER_METHODS.providerStopSession, { threadId })
          .pipe(Effect.tap(() => providerSessionDirectory.remove(threadId))),
    });

  const rollbackProviderConversation: WorkspaceRuntimeRouterShape["rollbackProviderConversation"] = (
    input,
  ) =>
    routeThread({
      threadId: input.threadId,
      local: () => providerService.rollbackConversation(input),
      remote: (_resolved, remoteHostId) =>
        callRemote(remoteHostId, REMOTE_HELPER_METHODS.providerRollbackThread, input).pipe(
          Effect.asVoid,
        ),
    });

  return {
    providerEvents: Stream.fromPubSub(providerEvents),
    subscribeTerminalEvents: (listener) =>
      Effect.sync(() => {
        terminalListeners.add(listener);
        return () => {
          terminalListeners.delete(listener);
        };
      }),
    resolveProject,
    listProviderSessions,
    startProviderSession,
    getProviderCapabilities,
    sendProviderTurn,
    interruptProviderTurn,
    respondToProviderRequest,
    respondToProviderUserInput,
    stopProviderSession,
    rollbackProviderConversation,
    projectSearchEntries: (input) =>
      routeProject({
        projectId: input.projectId,
        cwd: input.cwd,
        local: (project) =>
          Effect.tryPromise({
            try: () =>
              searchWorkspaceEntries({
                cwd: project.workspaceRoot,
                query: input.query,
                limit: input.limit,
              }),
            catch: (cause) => toWorkspaceRuntimeRouterError("projectSearchEntries", cause),
          }),
        remote: (project, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.workspaceSearchEntries, {
            cwd: project.workspaceRoot,
            query: input.query,
            limit: input.limit,
          }),
      }),
    projectWriteFile: (input) =>
      routeProject({
        projectId: input.projectId,
        cwd: input.cwd,
        local: (project) =>
          Effect.gen(function* () {
            const target = yield* resolveWorkspaceWritePath(project.workspaceRoot, input.relativePath);
            yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true });
            yield* fileSystem.writeFileString(target.absolutePath, input.contents);
            return { relativePath: target.relativePath };
          }),
        remote: (project, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.workspaceWriteFile, {
            workspaceRoot: project.workspaceRoot,
            relativePath: input.relativePath,
            contents: input.contents,
          }),
      }),
    openInEditor: (input: OpenInEditorInput) =>
      openInEditor(input).pipe(
        Effect.mapError((cause) => toWorkspaceRuntimeRouterError("openInEditor", cause)),
      ),
    gitStatus: (input) =>
      routeProjectGitOperation(input, {
        local: (cwd) => gitManager.status({ cwd }),
        remote: (cwd, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.gitStatus, { cwd }),
      }),
    gitPull: (input) =>
      routeProjectGitOperation(input, {
        local: (cwd) => git.pullCurrentBranch(cwd),
        remote: (cwd, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.gitPull, { cwd }),
      }),
    gitRunStackedAction: (input) =>
      routeProjectGitOperation(input, {
        local: (cwd) => gitManager.runStackedAction({ ...input, cwd }),
        remote: (cwd, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.gitRunStackedAction, {
            cwd,
            action: input.action,
            commitMessage: input.commitMessage,
            featureBranch: input.featureBranch,
          }),
      }),
    gitListBranches: (input) =>
      routeProjectGitOperation(input, {
        local: (cwd) => git.listBranches({ cwd }),
        remote: (cwd, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.gitListBranches, { cwd }),
      }),
    gitCreateWorktree: (input) =>
      routeProjectGitOperation(input, {
        local: (cwd) => git.createWorktree({ ...input, cwd }),
        remote: (cwd, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.gitCreateWorktree, {
            cwd,
            branch: input.branch,
            newBranch: input.newBranch,
            path: input.path,
          }),
      }),
    gitRemoveWorktree: (input) =>
      routeProjectGitOperation(input, {
        local: (cwd) => git.removeWorktree({ ...input, cwd }),
        remote: (cwd, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.gitRemoveWorktree, {
            cwd,
            path: input.path,
            force: input.force,
          }),
      }),
    gitCreateBranch: (input) =>
      routeProjectGitOperation(input, {
        local: (cwd) => git.createBranch({ cwd, branch: input.branch }),
        remote: (cwd, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.gitCreateBranch, {
            cwd,
            branch: input.branch,
          }),
      }),
    gitCheckout: (input) =>
      routeProjectGitOperation(input, {
        local: (cwd) => Effect.scoped(git.checkoutBranch({ cwd, branch: input.branch })),
        remote: (cwd, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.gitCheckout, {
            cwd,
            branch: input.branch,
          }),
      }),
    gitInit: (input) =>
      routeProjectGitOperation(input, {
        local: (cwd) => git.initRepo({ cwd }),
        remote: (cwd, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.gitInit, { cwd }),
      }),
    terminalOpen: (input) =>
      routeThread({
        threadId: input.threadId as ThreadId,
        local: () => terminalManager.open(input),
        remote: (_resolved, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.terminalOpen, input),
      }),
    terminalWrite: (input) =>
      routeThread({
        threadId: input.threadId as ThreadId,
        local: () => terminalManager.write(input),
        remote: (_resolved, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.terminalWrite, input),
      }),
    terminalResize: (input) =>
      routeThread({
        threadId: input.threadId as ThreadId,
        local: () => terminalManager.resize(input),
        remote: (_resolved, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.terminalResize, input),
      }),
    terminalClear: (input) =>
      routeThread({
        threadId: input.threadId as ThreadId,
        local: () => terminalManager.clear(input),
        remote: (_resolved, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.terminalClear, input),
      }),
    terminalRestart: (input) =>
      routeThread({
        threadId: input.threadId as ThreadId,
        local: () => terminalManager.restart(input),
        remote: (_resolved, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.terminalRestart, input),
      }),
    terminalClose: (input) =>
      routeThread({
        threadId: input.threadId as ThreadId,
        local: () => terminalManager.close(input),
        remote: (_resolved, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.terminalClose, input),
      }),
    checkpointIsGitRepository: (input) =>
      routeThread({
        threadId: input.threadId,
        local: () => checkpointStore.isGitRepository(input.cwd),
        remote: (_resolved, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.checkpointIsGitRepository, {
            cwd: input.cwd,
          }),
      }),
    checkpointCapture: (input) =>
      routeThread({
        threadId: input.threadId,
        local: () =>
          checkpointStore.captureCheckpoint({
            cwd: input.cwd,
            checkpointRef: input.checkpointRef as CheckpointRef,
          }),
        remote: (_resolved, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.checkpointCapture, {
            cwd: input.cwd,
            checkpointRef: input.checkpointRef,
          }),
      }),
    checkpointHasRef: (input) =>
      routeThread({
        threadId: input.threadId,
        local: () =>
          checkpointStore.hasCheckpointRef({
            cwd: input.cwd,
            checkpointRef: input.checkpointRef as CheckpointRef,
          }),
        remote: (_resolved, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.checkpointHasRef, {
            cwd: input.cwd,
            checkpointRef: input.checkpointRef,
          }),
      }),
    checkpointRestore: (input) =>
      routeThread({
        threadId: input.threadId,
        local: () => {
          const restoreInput = {
            cwd: input.cwd,
            checkpointRef: input.checkpointRef as CheckpointRef,
            ...(input.fallbackToHead === undefined
              ? {}
              : { fallbackToHead: input.fallbackToHead }),
          };
          return checkpointStore.restoreCheckpoint(restoreInput);
        },
        remote: (_resolved, remoteHostId) => {
          const restoreInput = {
            cwd: input.cwd,
            checkpointRef: input.checkpointRef,
            ...(input.fallbackToHead === undefined
              ? {}
              : { fallbackToHead: input.fallbackToHead }),
          };
          return callRemote(remoteHostId, REMOTE_HELPER_METHODS.checkpointRestore, restoreInput);
        },
      }),
    checkpointDiff: (input) =>
      routeThread({
        threadId: input.threadId,
        local: () => {
          const diffInput = {
            cwd: input.cwd,
            fromCheckpointRef: input.fromCheckpointRef as CheckpointRef,
            toCheckpointRef: input.toCheckpointRef as CheckpointRef,
            ...(input.fallbackFromToHead === undefined
              ? {}
              : { fallbackFromToHead: input.fallbackFromToHead }),
          };
          return checkpointStore.diffCheckpoints(diffInput);
        },
        remote: (_resolved, remoteHostId) => {
          const diffInput = {
            cwd: input.cwd,
            fromCheckpointRef: input.fromCheckpointRef,
            toCheckpointRef: input.toCheckpointRef,
            ...(input.fallbackFromToHead === undefined
              ? {}
              : { fallbackFromToHead: input.fallbackFromToHead }),
          };
          return callRemote(remoteHostId, REMOTE_HELPER_METHODS.checkpointDiff, diffInput);
        },
      }),
    checkpointDeleteRefs: (input) =>
      routeThread({
        threadId: input.threadId,
        local: () =>
          checkpointStore.deleteCheckpointRefs({
            cwd: input.cwd,
            checkpointRefs: input.checkpointRefs as ReadonlyArray<CheckpointRef>,
          }),
        remote: (_resolved, remoteHostId) =>
          callRemote(remoteHostId, REMOTE_HELPER_METHODS.checkpointDeleteRefs, {
            cwd: input.cwd,
            checkpointRefs: input.checkpointRefs,
          }),
      }),
  } satisfies WorkspaceRuntimeRouterShape;
});

export const WorkspaceRuntimeRouterLive = Layer.effect(
  WorkspaceRuntimeRouter,
  makeWorkspaceRuntimeRouter,
);
