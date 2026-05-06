import type { StickyAiLoopState } from "./schema";

const toEpoch = (value: string): number => {
  if (!value) {
    return 0;
  }

  return Date.parse(value);
};

export const isQueuedFresh = (
  state: StickyAiLoopState,
  nowIso: string,
  dispatchGraceSeconds: number,
): boolean =>
  state.status === "queued" &&
  toEpoch(nowIso) - toEpoch(state.last_processed_at) < dispatchGraceSeconds * 1000;

export const isRunningFresh = (
  state: StickyAiLoopState,
  nowIso: string,
  executorTimeoutSeconds: number,
): boolean =>
  state.status === "running" &&
  toEpoch(nowIso) - toEpoch(state.last_processed_at) < executorTimeoutSeconds * 1000;

export const calculateDebounceSleepMs = (
  eventIso: string,
  state: StickyAiLoopState,
  debounceSeconds: number,
  debounceMaxSeconds: number,
): number => {
  const eventMs = toEpoch(eventIso);
  const burstStartedMs = state.burst_started_at ? toEpoch(state.burst_started_at) : eventMs;
  const lastSignalMs = state.last_signal_at ? toEpoch(state.last_signal_at) : eventMs;
  const wakeAtMs = Math.min(
    lastSignalMs + debounceSeconds * 1000,
    burstStartedMs + debounceMaxSeconds * 1000,
  );

  return Math.max(0, wakeAtMs - eventMs);
};

export const shouldResetForNewGeneration = (
  latestCommitIsFixerChild: boolean,
  currentSha: string,
  state: StickyAiLoopState,
): boolean => !latestCommitIsFixerChild && currentSha !== state.generation_sha;

export const shouldBlockRepeatedFindingSet = (
  latestCommitIsFixerChild: boolean,
  state: StickyAiLoopState,
  findingSetFingerprint: string,
): boolean =>
  latestCommitIsFixerChild &&
  Boolean(state.last_result_fingerprint) &&
  state.last_result_fingerprint === findingSetFingerprint;
