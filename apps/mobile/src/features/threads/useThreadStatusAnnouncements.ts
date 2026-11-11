import { useIsFocused } from "@react-navigation/native";
import {
  nextThreadAnnouncement,
  type ThreadActivitySnapshot,
  type ThreadAnnouncementMemory,
} from "@t3tools/client-runtime/state/thread-activity-announcement";
import { useEffect, useRef } from "react";
import { AccessibilityInfo } from "react-native";

import { useAppActive } from "../../lib/appState";

/** Tells VoiceOver and TalkBack when the open thread starts working, needs the user, or finishes. */
export function useThreadStatusAnnouncements({
  threadKey,
  status,
  requestId,
  runId,
  runStatus,
  detailBehind,
}: ThreadActivitySnapshot & {
  /** Null when nothing should be announced, such as a provider subagent's thread. */
  readonly threadKey: string | null;
  /** See isDetailBehindShell. */
  readonly detailBehind: boolean;
}) {
  // A retained route stays mounted under the screen above it; it speaks only while shown,
  // and starts from a silent baseline when it is shown again.
  const focused = useIsFocused();
  const appActive = useAppActive();
  const activeKey = focused && appActive ? threadKey : null;
  const memoryRef = useRef<{ threadKey: string; memory: ThreadAnnouncementMemory } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- speaks committed status changes through the platform screen reader
  useEffect(() => {
    if (activeKey === null) {
      memoryRef.current = null;
      return;
    }
    if (detailBehind) return;
    const previous = memoryRef.current?.threadKey === activeKey ? memoryRef.current.memory : null;
    const next = nextThreadAnnouncement(previous, { status, requestId, runId, runStatus });
    memoryRef.current = { threadKey: activeKey, memory: next.memory };
    // Queued, like the web's polite region, so VoiceOver doesn't cut off what it is reading.
    if (next.announcement !== null) {
      AccessibilityInfo.announceForAccessibilityWithOptions(next.announcement, { queue: true });
    }
  }, [activeKey, status, requestId, runId, runStatus, detailBehind]);
}
