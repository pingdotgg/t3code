import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { useAppActive } from "../../lib/appState";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { nextThreadViewState, type ThreadViewState } from "./threadViewInterruption";

/** How long a thread shows, synced and in the foreground, after a resume or sync before it counts as read. */
const THREAD_READ_DWELL_MS = 2_000;

/**
 * The thread while it counts as viewed. A synced open counts at once; after a resume or sync a
 * finished run may land unseen, so the view counts only once the thread has shown, synced, in the
 * foreground and uncovered, for a moment. Backing out sooner keeps it unread.
 */
export function useSettledThreadView(
  ref: ScopedThreadRef | null,
  synchronizing: boolean,
  covered: boolean,
): ScopedThreadRef | null {
  const active = useAppActive();
  const key = ref === null ? null : scopedThreadKey(ref.environmentId, ref.threadId);
  const visible = active && !synchronizing && key !== null;
  const [opened, setOpened] = useState<ThreadViewState | null>(null);
  const next = nextThreadViewState(opened, key, visible);
  if (next !== opened) setOpened(next);
  const interrupted = next?.interrupted ?? false;
  // A fresh view each time the thread shows again, so the wait restarts even if no timer ran
  // while the app was in the background or the thread was covered.
  const view = useMemo(
    () => (visible && !covered && key !== null ? { key } : null),
    [visible, covered, key],
  );
  const [settled, setSettled] = useState<{ readonly key: string } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- times how long a resumed or synced thread has shown in the foreground
  useEffect(() => {
    if (view === null || !interrupted) return;
    const timer = setTimeout(() => setSettled(view), THREAD_READ_DWELL_MS);
    return () => clearTimeout(timer);
  }, [view, interrupted]);
  if (!visible) return null;
  if (!interrupted) return ref;
  return view !== null && settled === view ? ref : null;
}
