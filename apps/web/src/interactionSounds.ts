import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export type InteractionSoundCue = "bloom" | "success";

interface ThreadSoundState {
  readonly completedTurn: string | null;
  readonly hasPendingUserAction: boolean;
}

export type ThreadSoundStateByKey = ReadonlyMap<string, ThreadSoundState>;

function threadKey(thread: EnvironmentThreadShell): string {
  return `${thread.environmentId}:${thread.id}`;
}

function completedTurn(thread: EnvironmentThreadShell): string | null {
  const latestTurn = thread.latestTurn;
  if (latestTurn?.state !== "completed" || latestTurn.completedAt === null) {
    return null;
  }
  return `${latestTurn.turnId}:${latestTurn.completedAt}`;
}

export function captureThreadSoundState(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ThreadSoundStateByKey {
  return new Map(
    threads.map((thread) => [
      threadKey(thread),
      {
        completedTurn: completedTurn(thread),
        hasPendingUserAction: thread.hasPendingUserInput || thread.hasPendingApprovals,
      },
    ]),
  );
}

/**
 * While client settings are still hydrating, keep a sound baseline without
 * advancing known thread state. Newly seen threads are admitted so later
 * transitions can still produce cues once hydration completes.
 */
export function captureThreadSoundStateWhileSettingsHydrating(
  previous: ThreadSoundStateByKey | null,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ThreadSoundStateByKey {
  const next = captureThreadSoundState(threads);
  if (previous === null) {
    return next;
  }

  const merged = new Map(previous);
  for (const [key, state] of next) {
    if (!merged.has(key)) {
      merged.set(key, state);
    }
  }
  return merged;
}

export function deriveInteractionSoundCues(
  previous: ThreadSoundStateByKey,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): InteractionSoundCue[] {
  const cues: InteractionSoundCue[] = [];

  for (const thread of threads) {
    const prior = previous.get(threadKey(thread));
    const nextCompletedTurn = completedTurn(thread);

    if (prior && nextCompletedTurn !== null && prior.completedTurn !== nextCompletedTurn) {
      cues.push("success");
    }
    const hasPendingUserAction = thread.hasPendingUserInput || thread.hasPendingApprovals;
    if (prior && hasPendingUserAction && !prior.hasPendingUserAction) {
      cues.push("bloom");
    }
  }

  return cues;
}
