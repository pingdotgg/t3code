import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export type InteractionSoundCue = "bloom" | "success";

interface ThreadSoundState {
  readonly completedTurn: string | null;
  readonly hasPendingUserInput: boolean;
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
        hasPendingUserInput: thread.hasPendingUserInput,
      },
    ]),
  );
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
    if (prior && thread.hasPendingUserInput && !prior.hasPendingUserInput) {
      cues.push("bloom");
    }
  }

  return cues;
}
