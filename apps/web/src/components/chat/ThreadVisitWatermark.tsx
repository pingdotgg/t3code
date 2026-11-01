import { useAtomMount } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { createThreadVisitTracker } from "@t3tools/client-runtime/state/thread-visits";
import { type ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { useUiStateStore } from "../../uiStateStore";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";

const wakeAwareVisitShell = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.make((get) => {
    const shell = get(environmentThreadShells.threadShellAtom(ref));
    if (shell === null) return null;
    const nowMs = Date.now();
    const wokeAt = threadWokeAt(shell, { now: new Date(nowMs).toISOString() });
    const wakeAtMs = shell.snoozedUntil == null ? NaN : Date.parse(shell.snoozedUntil);
    // Snooze expiry advances the visit watermark without a server event.
    if (wokeAt === null && wakeAtMs > nowMs) {
      const timer = setTimeout(
        () => get.refreshSelf(),
        Math.min(wakeAtMs - nowMs + 50, 2_147_483_647),
      );
      get.addFinalizer(() => clearTimeout(timer));
    }
    return { ...shell, wokeAt };
  }).pipe(Atom.withLabel(`web-thread-visit-shell:${key}`));
});

const threadVisitTracker = createThreadVisitTracker({
  threadShellAtom: (ref) => wakeAwareVisitShell(threadKey(ref)),
  visit: threadEnvironment.visit,
  markLocalVisit: (ref, visitedAt) =>
    useUiStateStore.getState().markThreadVisited(scopedThreadKey(ref), visitedAt),
});

// The visit watermark is the one part of the chat view that follows the
// shell's updatedAt, which ticks while a run streams. The tracker subscribes to
// it outside React, so ChatView keeps reading the quiet shell.
export function ThreadVisitWatermark(props: { readonly threadRef: ScopedThreadRef }) {
  useAtomMount(threadVisitTracker(props.threadRef));
  return null;
}
