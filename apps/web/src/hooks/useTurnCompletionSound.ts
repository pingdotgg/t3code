import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useEffect, useRef } from "react";

import { playTurnCompletionSound } from "~/audio/turnChime";
import { useClientSettings } from "./useSettings";
import { useThreadShells } from "~/state/entities";

export function detectNewTurnCompletions(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  previousCompletions: Readonly<Record<string, string>>,
  sessionStartedAtMs: number,
): {
  readonly hasNewCompletion: boolean;
  readonly nextCompletions: Record<string, string>;
} {
  const nextCompletions: Record<string, string> = { ...previousCompletions };
  let hasNewCompletion = false;

  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const completedAt = thread.latestTurn?.completedAt;
    if (!completedAt) continue;

    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const previousCompletedAt = previousCompletions[threadKey];

    if (previousCompletedAt !== completedAt) {
      nextCompletions[threadKey] = completedAt;
      const completedAtMs = Date.parse(completedAt);
      if (!Number.isNaN(completedAtMs) && completedAtMs >= sessionStartedAtMs) {
        hasNewCompletion = true;
      }
    }
  }

  return { hasNewCompletion, nextCompletions };
}

export function useTurnCompletionSound(): void {
  const settings = useClientSettings();
  const threads = useThreadShells();
  const sessionStartedAtRef = useRef<number>(Date.now());
  const knownCompletionsRef = useRef<Record<string, string>>({});
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!initializedRef.current) {
      const initialMap: Record<string, string> = {};
      for (const thread of threads) {
        if (thread.latestTurn?.completedAt) {
          const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          initialMap[key] = thread.latestTurn.completedAt;
        }
      }
      knownCompletionsRef.current = initialMap;
      initializedRef.current = true;
      return;
    }

    const { hasNewCompletion, nextCompletions } = detectNewTurnCompletions(
      threads,
      knownCompletionsRef.current,
      sessionStartedAtRef.current,
    );
    knownCompletionsRef.current = nextCompletions;

    if (hasNewCompletion && settings.soundNotificationsEnabled) {
      playTurnCompletionSound();
    }
  }, [threads, settings.soundNotificationsEnabled]);
}
