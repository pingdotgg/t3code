import { useAtomValue } from "@effect/atom-react";
import { secondTick } from "@t3tools/client-runtime/clock";
import { type VcsActionState, type VcsActionTarget } from "@t3tools/client-runtime/state/vcs";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { useSyncExternalStore } from "react";

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

const gitActionResultAtom = Atom.make<GitActionResultNotification | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:git-action-result"),
);
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

function broadcast(result: GitActionResultNotification | null): void {
  appAtomRegistry.set(gitActionResultAtom, result);
}

export function showGitActionResult(result: GitActionResultNotification): void {
  // Best effort: devices without a haptics engine reject.
  Haptics.notificationAsync(
    result.type === "success"
      ? Haptics.NotificationFeedbackType.Success
      : Haptics.NotificationFeedbackType.Error,
  ).catch(() => undefined);
  if (dismissTimer) clearTimeout(dismissTimer);
  broadcast(result);
  dismissTimer = setTimeout(() => {
    dismissTimer = null;
    broadcast(null);
  }, RESULT_DISMISS_MS);
}

export function dismissGitActionResult(): void {
  if (dismissTimer) clearTimeout(dismissTimer);
  dismissTimer = null;
  broadcast(null);
}

function useGitActionResultNotification(): {
  readonly result: GitActionResultNotification | null;
  readonly dismiss: () => void;
} {
  const result = useAtomValue(gitActionResultAtom);
  return { result, dismiss: dismissGitActionResult };
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

function formatElapsedSeconds(ms: number | null, nowMs: number): string | null {
  if (ms === null) return null;
  const elapsed = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (elapsed < 2) return null;
  return `Running for ${elapsed}s`;
}

/** Progress in the thread's own folder, or in the repository the thread last acted on. */
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
  const { result } = useGitActionResultNotification();

  // Only a running action shows elapsed time, so only it subscribes to the second tick.
  const nowMs = useSyncExternalStore(
    actionState.isRunning ? secondTick.subscribe : subscribeNever,
    secondTick.getSnapshot,
  );

  if (actionState.isRunning) {
    const description =
      actionState.lastOutputLine ??
      formatElapsedSeconds(actionState.hookStartedAtMs ?? actionState.phaseStartedAtMs, nowMs);
    return {
      phase: "running",
      label: actionState.currentLabel,
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
