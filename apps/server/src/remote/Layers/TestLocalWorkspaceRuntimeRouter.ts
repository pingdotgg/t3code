import { Effect, Layer } from "effect";

import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  WorkspaceRuntimeRouter,
  WorkspaceRuntimeRouterError,
  type WorkspaceRuntimeRouterShape,
} from "../Services/WorkspaceRuntimeRouter.ts";

function unsupported<T>(operation: string): Effect.Effect<T, never, never> {
  return Effect.die(new Error(`Unsupported test runtime router operation: ${operation}`));
}

function wrapRuntimeEffect<T, E>(
  operation: string,
  effect: Effect.Effect<T, E, never>,
): Effect.Effect<T, WorkspaceRuntimeRouterError, never> {
  return effect.pipe(
    Effect.mapError((cause) => new WorkspaceRuntimeRouterError({ operation, cause })),
  );
}

function makeRouter(
  providerService: ProviderService["Service"],
  checkpointStore?: CheckpointStore["Service"],
): WorkspaceRuntimeRouterShape {
  return {
    providerEvents: providerService.streamEvents,
    subscribeTerminalEvents: () => Effect.succeed(() => {}),
    projectSearchEntries: () => unsupported("projectSearchEntries"),
    projectWriteFile: () => unsupported("projectWriteFile"),
    openInEditor: () => unsupported("openInEditor"),
    gitStatus: () => unsupported("gitStatus"),
    gitPull: () => unsupported("gitPull"),
    gitRunStackedAction: () => unsupported("gitRunStackedAction"),
    gitListBranches: () => unsupported("gitListBranches"),
    gitCreateWorktree: () => unsupported("gitCreateWorktree"),
    gitRemoveWorktree: () => unsupported("gitRemoveWorktree"),
    gitCreateBranch: () => unsupported("gitCreateBranch"),
    gitCheckout: () => unsupported("gitCheckout"),
    gitInit: () => unsupported("gitInit"),
    terminalOpen: () => unsupported("terminalOpen"),
    terminalWrite: () => unsupported("terminalWrite"),
    terminalResize: () => unsupported("terminalResize"),
    terminalClear: () => unsupported("terminalClear"),
    terminalRestart: () => unsupported("terminalRestart"),
    terminalClose: () => unsupported("terminalClose"),
    listProviderSessions: () =>
      wrapRuntimeEffect("listProviderSessions", providerService.listSessions()),
    startProviderSession: (threadId, input) =>
      wrapRuntimeEffect("startProviderSession", providerService.startSession(threadId, input)),
    getProviderCapabilities: (_threadId, provider) =>
      wrapRuntimeEffect("getProviderCapabilities", providerService.getCapabilities(provider)),
    sendProviderTurn: (input) => wrapRuntimeEffect("sendProviderTurn", providerService.sendTurn(input)),
    interruptProviderTurn: (input) =>
      wrapRuntimeEffect("interruptProviderTurn", providerService.interruptTurn(input)),
    respondToProviderRequest: (input) =>
      wrapRuntimeEffect("respondToProviderRequest", providerService.respondToRequest(input)),
    respondToProviderUserInput: (input) =>
      wrapRuntimeEffect("respondToProviderUserInput", providerService.respondToUserInput(input)),
    stopProviderSession: (threadId) =>
      wrapRuntimeEffect("stopProviderSession", providerService.stopSession({ threadId })),
    rollbackProviderConversation: (input) =>
      wrapRuntimeEffect("rollbackProviderConversation", providerService.rollbackConversation(input)),
    checkpointIsGitRepository: ({ cwd }) =>
      checkpointStore
        ? wrapRuntimeEffect("checkpointIsGitRepository", checkpointStore.isGitRepository(cwd))
        : unsupported("checkpointIsGitRepository"),
    checkpointCapture: ({ cwd, checkpointRef }) =>
      checkpointStore
        ? wrapRuntimeEffect(
            "checkpointCapture",
            checkpointStore.captureCheckpoint({ cwd, checkpointRef }),
          )
        : unsupported("checkpointCapture"),
    checkpointHasRef: ({ cwd, checkpointRef }) =>
      checkpointStore
        ? wrapRuntimeEffect(
            "checkpointHasRef",
            checkpointStore.hasCheckpointRef({ cwd, checkpointRef }),
          )
        : unsupported("checkpointHasRef"),
    checkpointRestore: ({ cwd, checkpointRef, fallbackToHead }) =>
      checkpointStore
        ? wrapRuntimeEffect(
            "checkpointRestore",
            checkpointStore.restoreCheckpoint({
              cwd,
              checkpointRef,
              ...(fallbackToHead === undefined ? {} : { fallbackToHead }),
            }),
          )
        : unsupported("checkpointRestore"),
    checkpointDiff: ({ cwd, fromCheckpointRef, toCheckpointRef, fallbackFromToHead }) =>
      checkpointStore
        ? wrapRuntimeEffect(
            "checkpointDiff",
            checkpointStore.diffCheckpoints({
              cwd,
              fromCheckpointRef,
              toCheckpointRef,
              ...(fallbackFromToHead === undefined ? {} : { fallbackFromToHead }),
            }),
          )
        : unsupported("checkpointDiff"),
    checkpointDeleteRefs: ({ cwd, checkpointRefs }) =>
      checkpointStore
        ? wrapRuntimeEffect(
            "checkpointDeleteRefs",
            checkpointStore.deleteCheckpointRefs({ cwd, checkpointRefs }),
          )
        : unsupported("checkpointDeleteRefs"),
    resolveProject: (projectId) =>
      Effect.succeed({
        id: projectId,
        workspaceRoot: process.cwd(),
        executionTarget: "local",
        remoteHostId: null,
      }),
  };
}

const make = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore;
  return makeRouter(providerService, checkpointStore);
});

export const TestLocalWorkspaceRuntimeRouterLive = Layer.effect(WorkspaceRuntimeRouter, make);

export const TestProviderWorkspaceRuntimeRouterLive = Layer.effect(
  WorkspaceRuntimeRouter,
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    return makeRouter(providerService);
  }),
);
