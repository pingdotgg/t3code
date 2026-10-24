import { memo, useEffect, useRef } from "react";

import { useLiveRegion } from "../../hooks/useLiveRegion";

import {
  nextThreadAnnouncement,
  type ThreadActivitySnapshot,
  type ThreadAnnouncementMemory,
} from "./threadActivityAnnouncement";

/** One polite live region for the open thread. */
export const ThreadActivityAnnouncer = memo(function ThreadActivityAnnouncer({
  threadKey,
  status,
  requestId,
  runId,
  runStatus,
  detailBehind,
}: ThreadActivitySnapshot & {
  /** Null while the timeline shows another thread during a switch. */
  readonly threadKey: string | null;
  /** See isDetailBehindShell. */
  readonly detailBehind: boolean;
}) {
  const { regionRef, announce, clear } = useLiveRegion();
  const memoryRef = useRef<{ threadKey: string; memory: ThreadAnnouncementMemory } | null>(null);

  useEffect(() => {
    if (threadKey === null) {
      memoryRef.current = null;
      clear();
      return;
    }
    if (detailBehind) return;
    const previous = memoryRef.current?.threadKey === threadKey ? memoryRef.current.memory : null;
    const { memory, announcement } = nextThreadAnnouncement(previous, {
      status,
      requestId,
      runId,
      runStatus,
    });
    memoryRef.current = { threadKey, memory };
    if (previous === null) clear();
    else if (announcement !== null) announce(announcement);
  }, [threadKey, status, requestId, runId, runStatus, detailBehind, announce, clear]);

  // No role="status": Orca 50 maps it to a status bar in Chromium and drops its updates.
  return <div ref={regionRef} aria-live="polite" className="sr-only" />;
});
