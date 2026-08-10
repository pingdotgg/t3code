import type { EnvironmentThreadShell } from "./state/shell.ts";

export type InteractionSoundCue = "bloom" | "success";

interface ThreadSoundState {
  readonly completedTurn: string | null;
  readonly userInitiatedTurn: string | null;
  readonly hasPendingUserInput: boolean;
  readonly hasPendingApprovals: boolean;
}

export type ThreadSoundStateByKey = ReadonlyMap<string, ThreadSoundState>;

export function shouldPlayInteractionSound(
  cue: InteractionSoundCue,
  completionSoundEnabled: boolean,
): boolean {
  return cue !== "success" || completionSoundEnabled;
}

function threadKey(thread: EnvironmentThreadShell): string {
  return `${thread.environmentId}:${thread.id}`;
}

function completedTurn(thread: EnvironmentThreadShell): string | null {
  const latestTurn = thread.latestTurn;
  if (latestTurn?.state !== "completed" || latestTurn.completedAt === null) {
    return null;
  }
  return latestTurn.turnId;
}

const USER_TURN_START_WINDOW_MS = 2 * 60 * 1_000;

function userInitiatedTurn(thread: EnvironmentThreadShell): string | null {
  const latestTurn = thread.latestTurn;
  if (latestTurn === null) {
    return null;
  }

  // Current servers expose the exact message/turn association from the
  // projection. A null association explicitly identifies synthetic provider
  // work, while undefined means the shell came from an older server.
  if (latestTurn.initiatingUserMessageId !== undefined) {
    return latestTurn.initiatingUserMessageId === null ? null : latestTurn.turnId;
  }

  if (thread.latestUserMessageAt === null) {
    return null;
  }

  const requestedAt = Date.parse(latestTurn.requestedAt);
  const latestUserMessageAt = Date.parse(thread.latestUserMessageAt);
  if (!Number.isFinite(requestedAt) || !Number.isFinite(latestUserMessageAt)) {
    return null;
  }

  // A normal prompt is recorded before provider startup, while synthetic
  // background turns have no nearby initiating message. Keep the same bounded
  // adoption window used for queued turn starts so an old prompt cannot claim
  // unrelated background work. A later steering message is also excluded
  // because it falls after requestedAt.
  const startupDelay = requestedAt - latestUserMessageAt;
  if (startupDelay < 0 || startupDelay > USER_TURN_START_WINDOW_MS) {
    return null;
  }

  return latestTurn.turnId;
}

export function captureThreadSoundState(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ThreadSoundStateByKey {
  return new Map(
    threads.map((thread) => [
      threadKey(thread),
      {
        completedTurn: completedTurn(thread),
        userInitiatedTurn: userInitiatedTurn(thread),
        hasPendingUserInput: thread.hasPendingUserInput,
        hasPendingApprovals: thread.hasPendingApprovals,
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
    const nextUserInitiatedTurn = userInitiatedTurn(thread);

    if (
      prior &&
      nextCompletedTurn !== null &&
      prior.completedTurn !== nextCompletedTurn &&
      nextUserInitiatedTurn === nextCompletedTurn
    ) {
      cues.push("success");
    }
    if (
      prior &&
      ((thread.hasPendingUserInput && !prior.hasPendingUserInput) ||
        (thread.hasPendingApprovals && !prior.hasPendingApprovals))
    ) {
      cues.push("bloom");
    }
  }

  return cues;
}

export interface ThreadSoundObservation {
  readonly state: ThreadSoundStateByKey;
  readonly cues: ReadonlyArray<InteractionSoundCue>;
}

/**
 * Advance one thread's sound state. Coordinators subscribe to individual
 * thread atoms so streaming updates only revisit the thread that changed.
 */
export function observeThreadSoundState(
  previous: ThreadSoundStateByKey | null,
  thread: EnvironmentThreadShell,
  options: {
    readonly environmentLive: boolean;
    readonly environmentPreviouslyLive: boolean;
    readonly settingsHydrated: boolean;
  },
): ThreadSoundObservation {
  const current = [thread];
  if (!options.environmentPreviouslyLive) {
    return { state: captureThreadSoundState(current), cues: [] };
  }
  const baseline =
    previous ??
    new Map([
      [
        threadKey(thread),
        {
          completedTurn: null,
          userInitiatedTurn: null,
          hasPendingUserInput: false,
          hasPendingApprovals: false,
        },
      ],
    ]);

  if (!options.environmentLive || !options.settingsHydrated) {
    return { state: baseline, cues: [] };
  }

  return {
    state: captureThreadSoundState(current),
    cues: deriveInteractionSoundCues(baseline, current),
  };
}
