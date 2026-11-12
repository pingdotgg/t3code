import { useEnvironmentQuery } from "./query";
import { useAtomValue } from "@effect/atom-react";
import { secondTick } from "@t3tools/client-runtime/clock";
import { type VcsActionState, type VcsActionTarget } from "@t3tools/client-runtime/state/vcs";
import { Atom } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { useSyncExternalStore } from "react";

import { appAtomRegistry } from "./atom-registry";
import { vcsActionManager } from "./vcs";
import { gitEnvironment } from "./git";
import { useAtomCommand } from "./use-atom-command";
import { CommandId } from "@t3tools/contracts";

export function useVcsActionState(target: VcsActionTarget): VcsActionState {
  return useAtomValue(vcsActionManager.stateAtom(target));
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
  readonly onCancel?: () => void;
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

export function useGitActionProgress(target: VcsActionTarget): GitActionProgress {
  const cancelSplit = useAtomCommand(gitEnvironment.cancelCommitWorkflow, { reportFailure: true });
  const actionState = useVcsActionState(target);
  const workflow = useEnvironmentQuery(
    target.environmentId && target.cwd
      ? gitEnvironment.workflowProgress({
          environmentId: target.environmentId,
          input: { cwd: target.cwd },
        })
      : null,
  ).data;
  const running = actionState.isRunning || workflow?.state === "running";
  const { result } = useGitActionResultNotification();

  // Only a running action shows elapsed time, so only it subscribes to the second tick.
  const nowMs = useSyncExternalStore(
    running ? secondTick.subscribe : subscribeNever,
    secondTick.getSnapshot,
  );

  if (running) {
    const description =
      actionState.lastOutputLine ??
      formatElapsedSeconds(actionState.hookStartedAtMs ?? actionState.phaseStartedAtMs, nowMs);
    return {
      phase: "running",
      label: workflow?.state === "running" ? workflow.label : actionState.currentLabel,
      description,
      ...(actionState.operation === "split_commits" &&
      actionState.actionId &&
      target.environmentId &&
      target.cwd
        ? {
            onCancel: () => {
              if (!actionState.actionId || !target.environmentId || !target.cwd) return;
              void cancelSplit({
                environmentId: target.environmentId,
                input: { commandId: CommandId.make(actionState.actionId), cwd: target.cwd },
              });
            },
          }
        : {}),
    };
  }

  if (actionState.error)
    return { phase: "error", label: "Source control failed", description: actionState.error };

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
