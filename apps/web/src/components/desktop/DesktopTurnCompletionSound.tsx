import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { OrchestrationLatestTurnState } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useThreadShells } from "../../state/entities";

export interface TurnCompletionSnapshot {
  readonly threadKey: string;
  readonly turnId: string | null;
  readonly state: OrchestrationLatestTurnState | null;
  readonly completedAt: string | null;
}

interface ObservedTurn {
  readonly turnId: string | null;
  readonly state: OrchestrationLatestTurnState | null;
}

export interface TurnCompletionTracker {
  readonly sync: (snapshots: readonly TurnCompletionSnapshot[]) => number;
}

export function createTurnCompletionTracker(): TurnCompletionTracker {
  let initialized = false;
  let observedTurns = new Map<string, ObservedTurn>();

  return {
    sync: (snapshots) => {
      const nextObservedTurns = new Map<string, ObservedTurn>();
      let completedTurnCount = 0;

      for (const snapshot of snapshots) {
        const currentTurn = {
          turnId: snapshot.turnId,
          state: snapshot.state,
        };
        nextObservedTurns.set(snapshot.threadKey, currentTurn);

        const previousTurn = observedTurns.get(snapshot.threadKey);
        if (
          initialized &&
          previousTurn !== undefined &&
          snapshot.state === "completed" &&
          snapshot.completedAt !== null &&
          (previousTurn.turnId !== snapshot.turnId || previousTurn.state !== "completed")
        ) {
          completedTurnCount += 1;
        }
      }

      observedTurns = nextObservedTurns;
      initialized = true;
      return completedTurnCount;
    },
  };
}

function DesktopTurnCompletionObserver({ playSound }: { readonly playSound: () => Promise<void> }) {
  const threadShells = useThreadShells();
  const trackerRef = useRef<TurnCompletionTracker | null>(null);
  trackerRef.current ??= createTurnCompletionTracker();

  useEffect(() => {
    const snapshots = threadShells.map((thread) => ({
      threadKey: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      turnId: thread.latestTurn?.turnId ?? null,
      state: thread.latestTurn?.state ?? null,
      completedAt: thread.latestTurn?.completedAt ?? null,
    }));
    const completedTurnCount = trackerRef.current?.sync(snapshots) ?? 0;

    for (let index = 0; index < completedTurnCount; index += 1) {
      void playSound().catch(() => undefined);
    }
  }, [playSound, threadShells]);

  return null;
}

export function DesktopTurnCompletionSound() {
  const playSound = window.desktopBridge?.playTurnCompletionSound;
  return typeof playSound === "function" ? (
    <DesktopTurnCompletionObserver playSound={playSound} />
  ) : null;
}
