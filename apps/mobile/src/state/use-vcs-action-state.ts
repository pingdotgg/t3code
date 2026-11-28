import { useAtomValue } from "@effect/atom-react";
import { secondTick } from "@t3tools/client-runtime/clock";
import {
  vcsActionLabelText,
  type VcsActionState,
  type VcsActionTarget,
} from "@t3tools/client-runtime/state/vcs";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { msg, useMessages } from "gt-react-native";
import { useSyncExternalStore } from "react";

import type { MessageResolver } from "../i18n/messages";
import { appAtomRegistry } from "./atom-registry";
import { vcsActionManager } from "./vcs";

export function useVcsActionState(target: VcsActionTarget): VcsActionState {
  return useAtomValue(vcsActionManager.stateAtom(target));
}

interface RepositoryGitAction {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
}

// The tracked repository a thread last ran an action in, so the thread can show its progress.
const repositoryGitActionAtom = Atom.make<RepositoryGitAction | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:repository-git-action"),
);

export function noteRepositoryGitAction(action: RepositoryGitAction): void {
  appAtomRegistry.set(repositoryGitActionAtom, action);
}

export interface GitActionResultNotification {
  readonly type: "success" | "error";
  readonly title: string;
  readonly description?: string;
  readonly prUrl?: string;
}

const RESULT_DISMISS_MS = 5_000;

interface PendingGitActionResult {
  readonly notification: GitActionResultNotification;
  readonly timer: ReturnType<typeof setTimeout>;
}

const gitActionResultsAtom = Atom.make<ReadonlyMap<string, PendingGitActionResult>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:git-action-results"),
);

function gitActionResultKey({ environmentId, threadId }: ScopedThreadRef): string {
  return JSON.stringify([environmentId, threadId]);
}

export function showGitActionResult({
  threadRef,
  ...notification
}: GitActionResultNotification & { readonly threadRef: ScopedThreadRef }): void {
  // Best effort: devices without a haptics engine reject.
  Haptics.notificationAsync(
    notification.type === "success"
      ? Haptics.NotificationFeedbackType.Success
      : Haptics.NotificationFeedbackType.Error,
  ).catch(() => undefined);
  const key = gitActionResultKey(threadRef);
  const results = new Map(appAtomRegistry.get(gitActionResultsAtom));
  const previous = results.get(key);
  if (previous !== undefined) clearTimeout(previous.timer);
  results.set(key, {
    notification,
    timer: setTimeout(() => dismissGitActionResult(threadRef), RESULT_DISMISS_MS),
  });
  appAtomRegistry.set(gitActionResultsAtom, results);
}

export function dismissGitActionResult(threadRef: ScopedThreadRef | null): void {
  if (threadRef === null) return;
  const key = gitActionResultKey(threadRef);
  const results = appAtomRegistry.get(gitActionResultsAtom);
  const entry = results.get(key);
  if (entry === undefined) return;
  clearTimeout(entry.timer);
  const next = new Map(results);
  next.delete(key);
  appAtomRegistry.set(gitActionResultsAtom, next);
}

export type GitActionProgressPhase = "idle" | "running" | "success" | "error";

export interface GitActionProgress {
  readonly phase: GitActionProgressPhase;
  readonly label: string | null;
  readonly description: string | null;
  readonly prUrl?: string;
}

const subscribeNever = () => () => {};

const EMPTY_PROGRESS: GitActionProgress = {
  phase: "idle",
  label: null,
  description: null,
};

function formatElapsedSeconds(
  ms: number | null,
  nowMs: number,
  resolve: MessageResolver,
): string | null {
  if (ms === null) return null;
  const elapsed = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (elapsed < 2) return null;
  return resolve(msg("Running for {elapsed}s", { elapsed: String(elapsed) }));
}

/** Checkout progress and the selected thread's own Git result. */
export function useGitActionProgress(
  target: VcsActionTarget,
  threadRef: ScopedThreadRef | null,
): GitActionProgress {
  const threadFolderState = useVcsActionState(target);
  const repositoryCwd = useAtomValue(repositoryGitActionAtom, (action) =>
    action !== null &&
    threadRef !== null &&
    action.threadRef.environmentId === threadRef.environmentId &&
    action.threadRef.threadId === threadRef.threadId
      ? action.cwd
      : null,
  );
  const repositoryState = useVcsActionState({
    environmentId: threadRef?.environmentId ?? null,
    cwd: repositoryCwd,
  });
  const actionState = repositoryState.isRunning ? repositoryState : threadFolderState;
  const resultKey = threadRef === null ? null : gitActionResultKey(threadRef);
  const result = useAtomValue(gitActionResultsAtom, (results) =>
    resultKey === null ? undefined : results.get(resultKey)?.notification,
  );
  const resolve = useMessages();

  // Only a running action shows elapsed time, so only it subscribes to the second tick.
  const nowMs = useSyncExternalStore(
    actionState.isRunning ? secondTick.subscribe : subscribeNever,
    secondTick.getSnapshot,
  );

  if (actionState.isRunning) {
    const description =
      actionState.lastOutputLine ??
      formatElapsedSeconds(
        actionState.hookStartedAtMs ?? actionState.phaseStartedAtMs,
        nowMs,
        resolve,
      );
    return {
      phase: "running",
      label: vcsActionLabelText(actionState, resolve),
      description,
    };
  }

  if (result) {
    return {
      phase: result.type,
      label: result.title,
      description: result.description ?? null,
      prUrl: result.prUrl,
    };
  }

  return EMPTY_PROGRESS;
}
