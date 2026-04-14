import { useAtomValue } from "@effect/atom-react";
import {
  type GitActionState,
  type GitActionTarget,
  EMPTY_GIT_ACTION_ATOM,
  EMPTY_GIT_ACTION_STATE,
  createGitActionManager,
  getGitActionTargetKey,
  gitActionStateAtom,
} from "@t3tools/client-runtime";
import { useCallback, useEffect, useRef, useState } from "react";

import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { getEnvironmentClient } from "./use-remote-environment-registry";

export const gitActionManager = createGitActionManager({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => {
    const client = getEnvironmentClient(environmentId);
    return client ? client.git : null;
  },
  getActionId: uuidv4,
});

export function useGitActionState(target: GitActionTarget): GitActionState {
  const targetKey = getGitActionTargetKey(target);
  const state = useAtomValue(
    targetKey !== null ? gitActionStateAtom(targetKey) : EMPTY_GIT_ACTION_ATOM,
  );
  return targetKey === null ? EMPTY_GIT_ACTION_STATE : state;
}

// ---------------------------------------------------------------------------
// Git action result notification
// ---------------------------------------------------------------------------

export interface GitActionResultNotification {
  readonly type: "success" | "error";
  readonly title: string;
  readonly description?: string;
  readonly prUrl?: string;
}

const RESULT_DISMISS_MS = 5_000;

type ResultListener = (result: GitActionResultNotification | null) => void;
const resultListeners = new Set<ResultListener>();
let currentResult: GitActionResultNotification | null = null;
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

function broadcast(result: GitActionResultNotification | null): void {
  currentResult = result;
  for (const listener of resultListeners) {
    listener(result);
  }
}

export function showGitActionResult(result: GitActionResultNotification): void {
  if (dismissTimer) clearTimeout(dismissTimer);
  broadcast(result);
  dismissTimer = setTimeout(() => broadcast(null), RESULT_DISMISS_MS);
}

export function dismissGitActionResult(): void {
  if (dismissTimer) clearTimeout(dismissTimer);
  broadcast(null);
}

export function useGitActionResultNotification(): {
  readonly result: GitActionResultNotification | null;
  readonly dismiss: () => void;
} {
  const [result, setResult] = useState<GitActionResultNotification | null>(currentResult);

  useEffect(() => {
    resultListeners.add(setResult);
    setResult(currentResult);
    return () => {
      resultListeners.delete(setResult);
    };
  }, []);

  return { result, dismiss: dismissGitActionResult };
}

// ---------------------------------------------------------------------------
// Unified git action progress (combines running state + result notification)
// ---------------------------------------------------------------------------

export type GitActionProgressPhase = "idle" | "running" | "success" | "error";

export interface GitActionProgress {
  readonly phase: GitActionProgressPhase;
  readonly label: string | null;
  readonly description: string | null;
  readonly prUrl?: string;
}

const EMPTY_PROGRESS: GitActionProgress = {
  phase: "idle",
  label: null,
  description: null,
};

function formatElapsedSeconds(ms: number | null): string | null {
  if (ms === null) return null;
  const elapsed = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (elapsed < 2) return null;
  return `Running for ${elapsed}s`;
}

export function useGitActionProgress(target: GitActionTarget): GitActionProgress {
  const actionState = useGitActionState(target);
  const { result } = useGitActionResultNotification();

  const [, forceUpdate] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startElapsedTimer = useCallback(() => {
    if (intervalRef.current) return;
    intervalRef.current = setInterval(() => forceUpdate((n) => n + 1), 1000);
  }, []);

  const stopElapsedTimer = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (actionState.isRunning) {
      startElapsedTimer();
    } else {
      stopElapsedTimer();
    }
    return stopElapsedTimer;
  }, [actionState.isRunning, startElapsedTimer, stopElapsedTimer]);

  if (actionState.isRunning) {
    const description =
      actionState.lastOutputLine ??
      formatElapsedSeconds(actionState.hookStartedAtMs ?? actionState.phaseStartedAtMs);
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
