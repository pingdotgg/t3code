import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useEffect, useRef } from "react";

import { playTurnCompletionSound } from "~/audio/turnChime";
import { useClientSettings } from "./useSettings";
import { useThreadShells } from "~/state/entities";
import { isLatestTurnSettled } from "~/session-logic";

export function detectNewTurnCompletions(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  previousCompletions: Readonly<Record<string, string>>,
): {
  readonly hasNewCompletion: boolean;
  readonly nextCompletions: Record<string, string>;
} {
  const nextCompletions: Record<string, string> = { ...previousCompletions };
  let hasNewCompletion = false;

  for (const thread of threads) {
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (thread.archivedAt !== null) {
      delete nextCompletions[threadKey];
      continue;
    }
    const previousState = previousCompletions[threadKey];

    const isSettled =
      isLatestTurnSettled(thread.latestTurn, thread.session) &&
      thread.latestTurn?.state !== "running" &&
      Boolean(thread.latestTurn?.completedAt);

    if (!isSettled) {
      if (thread.session?.status === "running" || thread.latestTurn?.state === "running") {
        nextCompletions[threadKey] = "running";
      }
      continue;
    }

    const completedAt = thread.latestTurn?.completedAt;
    if (!completedAt) continue;

    if (previousState === undefined) {
      nextCompletions[threadKey] = completedAt;
      continue;
    }

    if (previousState !== completedAt) {
      nextCompletions[threadKey] = completedAt;
      hasNewCompletion = true;
    }
  }

  return { hasNewCompletion, nextCompletions };
}

export function useTurnCompletionSound(): void {
  const settings = useClientSettings();
  const threads = useThreadShells();
  const knownCompletionsRef = useRef<Record<string, string>>({});

  useEffect(() => {
    const { hasNewCompletion, nextCompletions } = detectNewTurnCompletions(
      threads,
      knownCompletionsRef.current,
    );
    knownCompletionsRef.current = nextCompletions;

    if (hasNewCompletion && settings.soundNotificationsEnabled) {
      playTurnCompletionSound();
    }
  }, [threads, settings.soundNotificationsEnabled]);
}
