import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { useAppActive } from "../../lib/appState";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { nextThreadViewState, type ThreadViewState } from "./threadViewInterruption";

/** How long a thread shows, synced and in the foreground, after a resume or sync before it counts as read. */
const THREAD_READ_DWELL_MS = 2_000;

/**
 * The thread while it counts as viewed, otherwise null. Opening a synced thread counts at once.
 * After the app leaves the foreground or the environment syncs, a run that finished meanwhile
 * may land before the user has looked, so the view counts again only once the thread has shown,
 * synced and in the foreground, for a moment; backing out sooner keeps it unread.
 */
export function useSettledThreadView(
  ref: ScopedThreadRef | null,
  synchronizing: boolean,
): ScopedThreadRef | null {
  const active = useAppActive();
  const key = ref === null ? null : scopedThreadKey(ref.environmentId, ref.threadId);
  const visible = active && !synchronizing && key !== null;
  const [opened, setOpened] = useState<ThreadViewState | null>(null);
  const next = nextThreadViewState(opened, key, visible);
  if (next !== opened) setOpened(next);
  const interrupted = next?.interrupted ?? false;
  // A fresh view each time the thread becomes visible again, so the wait restarts even if no
  // timer ran while the app was in the background.
  const view = useMemo(() => (visible && key !== null ? { key } : null), [visible, key]);
  const [settled, setSettled] = useState<{ readonly key: string } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- times how long a resumed or synced thread has shown in the foreground
  useEffect(() => {
    if (view === null || !interrupted) return;
    const timer = setTimeout(() => setSettled(view), THREAD_READ_DWELL_MS);
    return () => clearTimeout(timer);
  }, [view, interrupted]);
  if (view === null) return null;
  return !interrupted || settled === view ? ref : null;
}
