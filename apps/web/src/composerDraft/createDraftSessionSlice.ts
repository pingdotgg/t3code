import {
  ComposerDraftStoreGet,
  ComposerDraftStoreSet,
  ComposerDraftStoreState,
  DraftId,
  DraftThreadState,
  composerDraftHasUserContent,
} from "./draftTypes";
import {
  clearStaleFileUploadMetadata,
  createDraftThreadState,
  draftThreadHasOpenPreview,
  draftThreadsEqual,
  getComposerDraftState,
  isComposerThreadKeyInUse,
  isDraftThreadPromoting,
  logicalProjectDraftKey,
  projectDraftKey,
  removeDraftThreadReferences,
  resolveComposerDraftKey,
  scopedThreadRefsEqual,
  toProjectDraftSession,
} from "./draftStateHelpers";
import { ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";

export type ComposerDraftSessionSlice = Pick<
  ComposerDraftStoreState,
  | "getComposerDraft"
  | "getDraftSessionByLogicalProjectKey"
  | "getDraftThreadByProjectRef"
  | "getDraftSessionByProjectRef"
  | "getDraftSession"
  | "getDraftSessionByRef"
  | "getDraftIdByRef"
  | "getPromotedDraftRedirect"
  | "getDraftThread"
  | "getDraftThreadByRef"
  | "listDraftThreadKeys"
  | "hasDraftThreadsInEnvironment"
  | "setLogicalProjectDraftThreadId"
  | "setProjectDraftThreadId"
  | "setDraftThreadContext"
  | "clearProjectDraftThreadId"
  | "clearProjectDraftThreadById"
  | "markDraftThreadPromoting"
  | "finalizePromotedDraftThread"
  | "clearDraftThread"
>;

export function createDraftSessionSlice(
  set: ComposerDraftStoreSet,
  get: ComposerDraftStoreGet,
): ComposerDraftSessionSlice {
  return {
      getComposerDraft: (target) => getComposerDraftState(get(), target),
      getDraftSessionByLogicalProjectKey: (logicalProjectKey) => {
        const normalizedLogicalProjectKey = logicalProjectDraftKey(logicalProjectKey);
        if (normalizedLogicalProjectKey.length === 0) {
          return null;
        }
        const draftId =
          get().logicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey];
        if (!draftId) {
          return null;
        }
        const draftThread = get().draftThreadsByThreadKey[draftId];
        if (!draftThread || isDraftThreadPromoting(draftThread)) {
          return null;
        }
        return toProjectDraftSession(DraftId.make(draftId), draftThread);
      },
      getDraftThreadByProjectRef: (projectRef) => {
        return get().getDraftSessionByProjectRef(projectRef);
      },
      getDraftSessionByProjectRef: (projectRef) => {
        const state = get();
        for (const draftId of Object.values(
          state.logicalProjectDraftThreadKeyByLogicalProjectKey,
        )) {
          const draftThread = state.draftThreadsByThreadKey[draftId];
          if (!draftThread || isDraftThreadPromoting(draftThread)) {
            continue;
          }
          if (
            draftThread.projectId === projectRef.projectId &&
            draftThread.environmentId === projectRef.environmentId
          ) {
            return toProjectDraftSession(DraftId.make(draftId), draftThread);
          }
        }
        for (const [draftId, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
          if (isDraftThreadPromoting(draftThread)) {
            continue;
          }
          if (
            draftThread.projectId === projectRef.projectId &&
            draftThread.environmentId === projectRef.environmentId
          ) {
            return toProjectDraftSession(DraftId.make(draftId), draftThread);
          }
        }
        return null;
      },
      getDraftSession: (draftId) => get().draftThreadsByThreadKey[draftId] ?? null,
      getDraftSessionByRef: (threadRef) => {
        for (const draftSession of Object.values(get().draftThreadsByThreadKey)) {
          if (
            draftSession.environmentId === threadRef.environmentId &&
            draftSession.threadId === threadRef.threadId
          ) {
            return draftSession;
          }
        }
        return null;
      },
      getDraftIdByRef: (threadRef) => {
        for (const [draftId, draftSession] of Object.entries(get().draftThreadsByThreadKey)) {
          if (
            draftSession.environmentId === threadRef.environmentId &&
            draftSession.threadId === threadRef.threadId
          ) {
            return DraftId.make(draftId);
          }
        }
        return null;
      },
      getPromotedDraftRedirect: (draftId) => get().promotedDraftRedirects[draftId] ?? null,
      getDraftThread: (threadRef) => {
        if (typeof threadRef === "string") {
          return get().getDraftSession(DraftId.make(threadRef));
        }
        return get().getDraftSessionByRef(threadRef);
      },
      getDraftThreadByRef: (threadRef) => {
        return get().getDraftSessionByRef(threadRef);
      },
      listDraftThreadKeys: () =>
        Object.values(get().draftThreadsByThreadKey).map((draftThread) =>
          scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
        ),
      hasDraftThreadsInEnvironment: (environmentId) =>
        Object.values(get().draftThreadsByThreadKey).some(
          (draftThread) => draftThread.environmentId === environmentId,
        ),
      setLogicalProjectDraftThreadId: (logicalProjectKey, projectRef, draftId, options) => {
        const normalizedLogicalProjectKey = logicalProjectDraftKey(logicalProjectKey);
        if (normalizedLogicalProjectKey.length === 0 || draftId.length === 0) {
          return;
        }
        set((state) => {
          const existingThread = state.draftThreadsByThreadKey[draftId];
          const previousThreadKeyForLogicalProject =
            state.logicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey];
          const nextDraftThread = createDraftThreadState(
            projectRef,
            options?.threadId ?? existingThread?.threadId ?? ThreadId.make(draftId),
            normalizedLogicalProjectKey,
            existingThread,
            options,
          );
          const hasSameLogicalMapping = previousThreadKeyForLogicalProject === draftId;
          const hasNoStaleMappingsForDraft = Object.entries(
            state.logicalProjectDraftThreadKeyByLogicalProjectKey,
          ).every(
            ([logicalKey, mappedDraftId]) =>
              mappedDraftId !== draftId || logicalKey === normalizedLogicalProjectKey,
          );
          if (
            hasSameLogicalMapping &&
            hasNoStaleMappingsForDraft &&
            draftThreadsEqual(existingThread, nextDraftThread)
          ) {
            return state;
          }
          const nextLogicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string> =
            Object.fromEntries(
              Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
                ([logicalKey, mappedDraftId]) =>
                  mappedDraftId !== draftId || logicalKey === normalizedLogicalProjectKey,
              ),
            );
          nextLogicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey] =
            draftId;
          const nextDraftThreadsByThreadKey: Record<string, DraftThreadState> = {
            ...state.draftThreadsByThreadKey,
            [draftId]: nextDraftThread,
          };
          const existingDraft = state.draftsByThreadKey[draftId];
          let nextDraftsByThreadKey = state.draftsByThreadKey;
          if (
            existingThread &&
            existingThread.environmentId !== projectRef.environmentId &&
            existingDraft !== undefined
          ) {
            const nextDraft = clearStaleFileUploadMetadata(
              existingDraft,
              projectRef.environmentId,
            );
            if (nextDraft !== existingDraft) {
              nextDraftsByThreadKey = {
                ...state.draftsByThreadKey,
                [draftId]: nextDraft,
              };
            }
          }
          const previousDraftThread =
            previousThreadKeyForLogicalProject === undefined
              ? undefined
              : nextDraftThreadsByThreadKey[previousThreadKeyForLogicalProject];
          // Keep populated drafts unmapped: sidebar rows still expose them when a new draft is opened.
          if (
            previousThreadKeyForLogicalProject &&
            previousThreadKeyForLogicalProject !== draftId &&
            !isComposerThreadKeyInUse(
              nextLogicalProjectDraftThreadKeyByLogicalProjectKey,
              previousThreadKeyForLogicalProject,
            ) &&
            !isDraftThreadPromoting(previousDraftThread) &&
            !composerDraftHasUserContent(
              state.draftsByThreadKey[previousThreadKeyForLogicalProject],
            ) &&
            !draftThreadHasOpenPreview(previousDraftThread)
          ) {
            delete nextDraftThreadsByThreadKey[previousThreadKeyForLogicalProject];
            if (state.draftsByThreadKey[previousThreadKeyForLogicalProject] !== undefined) {
              nextDraftsByThreadKey = { ...nextDraftsByThreadKey };
              delete nextDraftsByThreadKey[previousThreadKeyForLogicalProject];
            }
          }
          return {
            draftsByThreadKey: nextDraftsByThreadKey,
            draftThreadsByThreadKey: nextDraftThreadsByThreadKey,
            logicalProjectDraftThreadKeyByLogicalProjectKey:
              nextLogicalProjectDraftThreadKeyByLogicalProjectKey,
          };
        });
      },
      setProjectDraftThreadId: (projectRef, draftId, options) => {
        get().setLogicalProjectDraftThreadId(
          projectDraftKey(projectRef),
          projectRef,
          draftId,
          options,
        );
      },
      setDraftThreadContext: (threadRef, options) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftThreadsByThreadKey[threadKey];
          if (!existing) {
            return state;
          }
          const nextProjectRef = options.projectRef ?? {
            environmentId: existing.environmentId,
            projectId: existing.projectId,
          };
          if (
            nextProjectRef.projectId.length === 0 ||
            nextProjectRef.environmentId.length === 0
          ) {
            return state;
          }
          const projectChanged =
            nextProjectRef.environmentId !== existing.environmentId ||
            nextProjectRef.projectId !== existing.projectId;
          const nextWorktreePath =
            options.worktreePath === undefined
              ? projectChanged
                ? null
                : existing.worktreePath
              : (options.worktreePath ?? null);
          const nextBranch =
            options.branch === undefined
              ? projectChanged
                ? null
                : existing.branch
              : (options.branch ?? null);
          const nextStartFromOrigin =
            options.startFromOrigin === undefined
              ? existing.startFromOrigin
              : options.startFromOrigin;
          const environmentSelection =
            options.environmentSelection ??
            (options.branch != null || options.worktreePath != null
              ? "manual"
              : existing.environmentSelection);
          const nextDraftThread: DraftThreadState = {
            threadId: existing.threadId,
            environmentId: nextProjectRef.environmentId,
            projectId: nextProjectRef.projectId,
            logicalProjectKey: existing.logicalProjectKey,
            ...(environmentSelection ? { environmentSelection } : {}),
            loadBalancedEnvironmentId:
              options.loadBalancedEnvironmentId === undefined
                ? projectChanged
                  ? null
                  : (existing.loadBalancedEnvironmentId ?? null)
                : options.loadBalancedEnvironmentId,
            createdAt:
              options.createdAt === undefined
                ? existing.createdAt
                : options.createdAt || existing.createdAt,
            runtimeMode: options.runtimeMode ?? existing.runtimeMode,
            interactionMode: options.interactionMode ?? existing.interactionMode,
            branch: nextBranch,
            worktreePath: nextWorktreePath,
            envMode:
              options.envMode ?? (nextWorktreePath ? "worktree" : (existing.envMode ?? "local")),
            startFromOrigin: nextStartFromOrigin,
            promotedTo: existing.promotedTo ?? null,
          };
          const isUnchanged =
            nextDraftThread.environmentId === existing.environmentId &&
            nextDraftThread.projectId === existing.projectId &&
            nextDraftThread.logicalProjectKey === existing.logicalProjectKey &&
            nextDraftThread.environmentSelection === existing.environmentSelection &&
            nextDraftThread.loadBalancedEnvironmentId === existing.loadBalancedEnvironmentId &&
            nextDraftThread.createdAt === existing.createdAt &&
            nextDraftThread.runtimeMode === existing.runtimeMode &&
            nextDraftThread.interactionMode === existing.interactionMode &&
            nextDraftThread.branch === existing.branch &&
            nextDraftThread.worktreePath === existing.worktreePath &&
            nextDraftThread.envMode === existing.envMode &&
            nextDraftThread.startFromOrigin === existing.startFromOrigin &&
            scopedThreadRefsEqual(nextDraftThread.promotedTo, existing.promotedTo);
          if (isUnchanged) {
            return state;
          }
          return {
            draftThreadsByThreadKey: {
              ...state.draftThreadsByThreadKey,
              [threadKey]: nextDraftThread,
            },
          };
        });
      },
      clearProjectDraftThreadId: (projectRef) => {
        set((state) => {
          const matchingThreadKeys = Object.entries(state.draftThreadsByThreadKey)
            .filter(
              ([, draftThread]) =>
                draftThread.projectId === projectRef.projectId &&
                draftThread.environmentId === projectRef.environmentId,
            )
            .map(([threadKey]) => threadKey);
          if (matchingThreadKeys.length === 0) {
            return state;
          }
          let nextState = {
            draftsByThreadKey: state.draftsByThreadKey,
            draftThreadsByThreadKey: state.draftThreadsByThreadKey,
            logicalProjectDraftThreadKeyByLogicalProjectKey:
              state.logicalProjectDraftThreadKeyByLogicalProjectKey,
          };
          for (const threadKey of matchingThreadKeys) {
            nextState = removeDraftThreadReferences(nextState, threadKey);
          }
          return nextState;
        });
      },
      clearProjectDraftThreadById: (projectRef, threadRef) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0) {
          return;
        }
        set((state) => {
          const draftThread = state.draftThreadsByThreadKey[threadKey];
          if (
            !draftThread ||
            draftThread.projectId !== projectRef.projectId ||
            draftThread.environmentId !== projectRef.environmentId
          ) {
            return state;
          }
          return removeDraftThreadReferences(state, threadKey);
        });
      },
      markDraftThreadPromoting: (threadRef, promotedTo) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef);
        if (!threadKey) {
          return;
        }
        set((state) => {
          const existing = state.draftThreadsByThreadKey[threadKey];
          if (!existing) {
            return state;
          }
          const nextPromotedTo =
            promotedTo ?? scopeThreadRef(existing.environmentId, existing.threadId);
          if (scopedThreadRefsEqual(existing.promotedTo, nextPromotedTo)) {
            return state;
          }
          return {
            draftThreadsByThreadKey: {
              ...state.draftThreadsByThreadKey,
              [threadKey]: {
                ...existing,
                promotedTo: nextPromotedTo,
              },
            },
          };
        });
      },
      finalizePromotedDraftThread: (threadRef) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftThreadsByThreadKey[threadKey];
          if (!existing?.promotedTo) {
            return state;
          }
          return {
            ...removeDraftThreadReferences(state, threadKey, existing.promotedTo),
            promotedDraftRedirects: {
              ...state.promotedDraftRedirects,
              [threadKey]: existing.promotedTo,
            },
          };
        });
      },
      clearDraftThread: (threadRef) => {
        const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
        if (threadKey.length === 0) {
          return;
        }
        set((state) => {
          const hasDraftThread = state.draftThreadsByThreadKey[threadKey] !== undefined;
          const hasLogicalProjectMapping = Object.values(
            state.logicalProjectDraftThreadKeyByLogicalProjectKey,
          ).includes(threadKey);
          const hasComposerDraft = state.draftsByThreadKey[threadKey] !== undefined;
          if (!hasDraftThread && !hasLogicalProjectMapping && !hasComposerDraft) {
            return state;
          }
          return removeDraftThreadReferences(state, threadKey);
        });
      },
  };
}
