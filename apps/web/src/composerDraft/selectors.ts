import { ComposerDraftModelState } from "./modelSelectionNormalization";
import {
  ComposerDraftStoreState,
  ComposerThreadDraftState,
  ComposerThreadTarget,
  DraftId,
  DraftThreadState,
  composerDraftHasUserContent,
} from "./draftTypes";
import {
  EMPTY_COMPOSER_DRAFT_MODEL_STATE,
  EMPTY_THREAD_DRAFT,
  getComposerDraftState,
  revokeDraftThreadPreviewUrls,
  scopedThreadRefsEqual,
  shouldRemoveDraft,
} from "./draftStateHelpers";
import { composerDebouncedStorage } from "./persistence";
import { composerDraftStore, useComposerDraftStore } from "./createComposerDraftStore";
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { draftModelPickMatchesThread } from "@t3tools/shared/model";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import type {
  EnvironmentShellState,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { waitForDraftHeroTransition } from "../components/chat/draftHeroTransition";
import { useShallow } from "zustand/react/shallow";
import * as Option from "effect/Option";

export function subscribeComposerDraftModelReconciliation(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly threadRefsAtom: Atom.Atom<ReadonlyArray<ScopedThreadRef>>;
  readonly threadShellAtom: (ref: ScopedThreadRef) => Atom.Atom<EnvironmentThreadShell | null>;
  readonly shellStateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentShellState, unknown>>;
}): () => void {
  const draftsAtom = Atom.make(composerDraftStore.getState());
  const unsubscribeDrafts = composerDraftStore.subscribe((state) =>
    input.registry.set(draftsAtom, state),
  );
  const threadKeysAtom = Atom.map(
    input.threadRefsAtom,
    (refs) => new Set(refs.map(scopedThreadKey)),
  );
  const matchesAtom = Atom.make((get) => {
    const state = get(draftsAtom);
    const threadKeys = get(threadKeysAtom);
    const matches: Array<readonly [string, ComposerThreadDraftState]> = [];
    for (const [key, draft] of Object.entries(state.draftsByThreadKey)) {
      // Local drafts can materialize a shell before their first turn is submitted.
      if (state.draftThreadsByThreadKey[key] || draft.activeProvider === null) continue;
      const ref = parseScopedThreadKey(key);
      const pick = draft.modelSelectionByProvider[draft.activeProvider];
      if (!ref || !pick || !threadKeys.has(key)) continue;
      const thread = get(input.threadShellAtom(ref));
      if (!thread || !draftModelPickMatchesThread(pick, thread.modelSelection)) continue;
      // Status and selection must come from the same emission; derived atoms can update apart.
      const shell = AsyncResult.getOrElse(get(input.shellStateAtom(ref.environmentId)), () => null);
      if (shell?.status !== "live") continue;
      const authoritativeThread = Option.getOrNull(shell.snapshot)?.threads.find(
        (candidate) => candidate.id === ref.threadId,
      );
      if (
        authoritativeThread &&
        draftModelPickMatchesThread(pick, authoritativeThread.modelSelection)
      ) {
        matches.push([key, draft]);
      }
    }
    return matches;
  });
  const unsubscribeMatches = input.registry.subscribe(
    matchesAtom,
    (matches) => {
      if (matches.length === 0) return;
      composerDraftStore.setState((state) => {
        const drafts = { ...state.draftsByThreadKey };
        for (const [key, matchedDraft] of matches) {
          if (drafts[key] !== matchedDraft) continue;
          const { modelSelectionExplicit: _explicit, ...retained } = matchedDraft;
          const draft = { ...retained, activeProvider: null, modelSelectionByProvider: {} };
          if (shouldRemoveDraft(draft)) delete drafts[key];
          else drafts[key] = draft;
        }
        return { draftsByThreadKey: drafts };
      });
    },
    { immediate: true },
  );
  return () => {
    unsubscribeMatches();
    unsubscribeDrafts();
  };
}

export function beginBackgroundDraftSubmissionByRef(threadRef: ScopedThreadRef): void {
  const threadKey = scopedThreadKey(threadRef);
  useComposerDraftStore.setState((state) => ({
    backgroundSubmissionThreadKeys: { ...state.backgroundSubmissionThreadKeys, [threadKey]: true },
  }));
}

export function clearBackgroundDraftSubmissionByRef(threadRef: ScopedThreadRef): void {
  const threadKey = scopedThreadKey(threadRef);
  useComposerDraftStore.setState((state) => {
    if (!state.backgroundSubmissionThreadKeys[threadKey]) {
      return state;
    }
    const backgroundSubmissionThreadKeys = { ...state.backgroundSubmissionThreadKeys };
    delete backgroundSubmissionThreadKeys[threadKey];
    return { backgroundSubmissionThreadKeys };
  });
}

export function clearComposerDraftsEnvironment(environmentId: EnvironmentId): void {
  useComposerDraftStore.setState((state) => {
    const removedThreadKeys = new Set<string>();

    for (const [threadKey, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
      if (draftThread.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }
    for (const threadKey of Object.keys(state.draftsByThreadKey)) {
      if (parseScopedThreadKey(threadKey)?.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }
    for (const [logicalProjectKey, threadKey] of Object.entries(
      state.logicalProjectDraftThreadKeyByLogicalProjectKey,
    )) {
      if (parseScopedProjectKey(logicalProjectKey)?.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }

    const nextLogicalMappings = Object.fromEntries(
      Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
        ([logicalProjectKey, threadKey]) =>
          parseScopedProjectKey(logicalProjectKey)?.environmentId !== environmentId &&
          !removedThreadKeys.has(threadKey),
      ),
    ) as Record<string, string>;
    const nextDraftThreads = Object.fromEntries(
      Object.entries(state.draftThreadsByThreadKey).filter(
        ([threadKey, draftThread]) =>
          draftThread.environmentId !== environmentId && !removedThreadKeys.has(threadKey),
      ),
    ) as Record<string, DraftThreadState>;
    const nextDrafts = Object.fromEntries(
      Object.entries(state.draftsByThreadKey).filter(([threadKey, draft]) => {
        if (!removedThreadKeys.has(threadKey)) {
          return true;
        }
        revokeDraftThreadPreviewUrls(draft);
        return false;
      }),
    ) as Record<string, ComposerThreadDraftState>;
    const nextBackgroundSubmissionThreadKeys = Object.fromEntries(
      Object.entries(state.backgroundSubmissionThreadKeys).filter(
        ([threadKey]) => parseScopedThreadKey(threadKey)?.environmentId !== environmentId,
      ),
    ) as Record<string, true>;
    const nextPromotedDraftRedirects = Object.fromEntries(
      Object.entries(state.promotedDraftRedirects).filter(
        ([, promotedTo]) => promotedTo.environmentId !== environmentId,
      ),
    ) as Record<string, ScopedThreadRef>;

    return {
      draftsByThreadKey: nextDrafts,
      draftThreadsByThreadKey: nextDraftThreads,
      logicalProjectDraftThreadKeyByLogicalProjectKey: nextLogicalMappings,
      backgroundSubmissionThreadKeys: nextBackgroundSubmissionThreadKeys,
      promotedDraftRedirects: nextPromotedDraftRedirects,
      rewindingThreadKeys: new Set(
        [...state.rewindingThreadKeys].filter(
          (threadKey) => parseScopedThreadKey(threadKey)?.environmentId !== environmentId,
        ),
      ),
    };
  });
  composerDebouncedStorage.flush();
}

export function useComposerThreadDraft(threadRef: ComposerThreadTarget): ComposerThreadDraftState {
  return useComposerDraftStore((state) => {
    return getComposerDraftState(state, threadRef) ?? EMPTY_THREAD_DRAFT;
  });
}

export function useThreadHasUnsentDraft(threadRef: ScopedThreadRef): boolean {
  return useComposerDraftStore((state) =>
    composerDraftHasUserContent(getComposerDraftState(state, threadRef)),
  );
}

export function useComposerDraftModelState(
  threadRef: ComposerThreadTarget,
): ComposerDraftModelState {
  return useComposerDraftStore(
    useShallow((state) => {
      const draft = getComposerDraftState(state, threadRef);
      return draft
        ? {
            activeProvider: draft.activeProvider,
            modelSelectionByProvider: draft.modelSelectionByProvider,
          }
        : EMPTY_COMPOSER_DRAFT_MODEL_STATE;
    }),
  );
}

export function markPromotedDraftThreadByRef(threadRef: ScopedThreadRef): void {
  const draftStore = useComposerDraftStore.getState();
  for (const [draftId, draftThread] of Object.entries(draftStore.draftThreadsByThreadKey)) {
    if (
      draftThread.environmentId === threadRef.environmentId &&
      draftThread.threadId === threadRef.threadId
    ) {
      draftStore.markDraftThreadPromoting(DraftId.make(draftId), threadRef);
    }
  }
}

export function restoreFailedDraftThread(
  draftId: DraftId,
  draftThread: DraftThreadState,
  threadId: ThreadId,
): void {
  useComposerDraftStore.setState((state) => ({
    draftThreadsByThreadKey: {
      ...state.draftThreadsByThreadKey,
      [draftId]: {
        ...(state.draftThreadsByThreadKey[draftId] ?? draftThread),
        threadId,
        ...(threadId !== draftThread.threadId ? { createdAt: new Date().toISOString() } : {}),
        promotedTo: null,
      },
    },
  }));
}

export function finalizePromotedDraftThreadByRef(threadRef: ScopedThreadRef): void {
  const draftStore = useComposerDraftStore.getState();
  for (const [draftId, draftThread] of Object.entries(draftStore.draftThreadsByThreadKey)) {
    const promotedRef = draftThread.promotedTo;
    const matches = promotedRef
      ? promotedRef.environmentId === threadRef.environmentId &&
        promotedRef.threadId === threadRef.threadId
      : draftThread.environmentId === threadRef.environmentId &&
        draftThread.threadId === threadRef.threadId;
    if (matches) {
      const target = DraftId.make(draftId);
      draftStore.markDraftThreadPromoting(target, threadRef);
      draftStore.finalizePromotedDraftThread(target);
    }
  }
  clearBackgroundDraftSubmissionByRef(threadRef);
}

export type DraftPromotionShell = Pick<EnvironmentThreadShell, "latestRun" | "latestUserMessageAt">;

/** The server owns a draft's send once its message persisted or its run started or stopped. */
export function resolveDraftPromotionNavigationTarget(input: {
  serverThreadRef: ScopedThreadRef | null;
  serverThread: DraftPromotionShell | null | undefined;
  backgroundSubmissionPending: boolean;
}): ScopedThreadRef | null {
  if (input.backgroundSubmissionPending) {
    return null;
  }
  const latestRun = input.serverThread?.latestRun ?? null;
  const runStarted = latestRun?.startedAt != null;
  const startupStopped =
    latestRun?.status === "failed" ||
    latestRun?.status === "interrupted" ||
    latestRun?.status === "cancelled";
  const messagePersisted = input.serverThread?.latestUserMessageAt != null;
  return runStarted || startupStopped || messagePersisted ? input.serverThreadRef : null;
}

/**
 * Drives every draft through promotion as server shells arrive: a draft whose reserved thread
 * appears on the server becomes promoting, and once the server owns its send (and any hero
 * transition has played) it finalizes into that thread. The draft route follows the redirect
 * that finalization records, so no route has to watch for these milestones.
 */
export function subscribeDraftThreadPromotion(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly threadRefsAtom: Atom.Atom<ReadonlyArray<ScopedThreadRef>>;
  readonly threadShellAtom: (ref: ScopedThreadRef) => Atom.Atom<DraftPromotionShell | null>;
}): () => void {
  // Only the promotion slices: prompt edits replace the store state on every keystroke.
  const promotionSlices = (state: ComposerDraftStoreState) => ({
    draftThreadsByThreadKey: state.draftThreadsByThreadKey,
    backgroundSubmissionThreadKeys: state.backgroundSubmissionThreadKeys,
  });
  const draftsAtom = Atom.make(promotionSlices(composerDraftStore.getState()));
  const unsubscribeDrafts = composerDraftStore.subscribe((state, previous) => {
    if (
      state.draftThreadsByThreadKey === previous.draftThreadsByThreadKey &&
      state.backgroundSubmissionThreadKeys === previous.backgroundSubmissionThreadKeys
    ) {
      return;
    }
    input.registry.set(draftsAtom, promotionSlices(state));
  });
  const threadKeysAtom = Atom.map(
    input.threadRefsAtom,
    (refs) => new Set(refs.map(scopedThreadKey)),
  );
  const milestonesAtom = Atom.make((get) => {
    const state = get(draftsAtom);
    const threadKeys = get(threadKeysAtom);
    const arrived: Array<readonly [DraftId, ScopedThreadRef]> = [];
    const owned: Array<readonly [DraftId, ScopedThreadRef]> = [];
    for (const [draftId, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
      const ref =
        draftThread.promotedTo ?? scopeThreadRef(draftThread.environmentId, draftThread.threadId);
      const threadKey = scopedThreadKey(ref);
      if (!threadKeys.has(threadKey)) continue;
      if (!draftThread.promotedTo) {
        arrived.push([DraftId.make(draftId), ref]);
        continue;
      }
      const target = resolveDraftPromotionNavigationTarget({
        serverThreadRef: ref,
        serverThread: get(input.threadShellAtom(ref)),
        backgroundSubmissionPending: state.backgroundSubmissionThreadKeys[threadKey] === true,
      });
      if (target) owned.push([DraftId.make(draftId), target]);
    }
    return { arrived, owned };
  });
  let disposed = false;
  const finalizing = new Set<DraftId>();
  const unsubscribeMilestones = input.registry.subscribe(
    milestonesAtom,
    ({ arrived, owned }) => {
      const store = composerDraftStore.getState();
      for (const [draftId, ref] of arrived) {
        store.markDraftThreadPromoting(draftId, ref);
      }
      for (const [draftId, ref] of owned) {
        if (finalizing.has(draftId)) continue;
        finalizing.add(draftId);
        void waitForDraftHeroTransition().then(() => {
          finalizing.delete(draftId);
          if (disposed) return;
          const current = composerDraftStore.getState().draftThreadsByThreadKey[draftId];
          if (!current || !scopedThreadRefsEqual(current.promotedTo, ref)) return;
          finalizePromotedDraftThreadByRef(ref);
        });
      }
    },
    { immediate: true },
  );
  return () => {
    disposed = true;
    unsubscribeMilestones();
    unsubscribeDrafts();
  };
}
