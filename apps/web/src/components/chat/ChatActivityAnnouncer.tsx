import {
  activityAnnouncementMessages,
  type ActivityAnnouncementState,
} from "@t3tools/client-runtime/activity-announcement";
import { useEffect, useRef, useState } from "react";

/**
 * Hidden status region that tells screen reader users when the agent starts,
 * finishes, or needs them. Kept as its own component so an announcement
 * re-renders only this node, not ChatView.
 */
export function ChatActivityAnnouncer(props: ActivityAnnouncementState) {
  const {
    threadKey,
    working,
    turnId,
    turnState,
    turnRequestedAt,
    approvalRequestId,
    userInputRequestId,
  } = props;
  const previousRef = useRef<ActivityAnnouncementState | null>(null);
  const restoreTimerRef = useRef<number | undefined>(undefined);
  const [announcement, setAnnouncement] = useState<string | null>(null);

  useEffect(() => () => window.clearTimeout(restoreTimerRef.current), []);

  useEffect(() => {
    const next = {
      threadKey,
      working,
      turnId,
      turnState,
      turnRequestedAt,
      approvalRequestId,
      userInputRequestId,
    };
    const previous = previousRef.current;
    previousRef.current = next;
    const messages = activityAnnouncementMessages(previous, next);
    if (messages.length > 0) {
      const message = messages.join(". ");
      // Empty the region first and fill it a moment later. Screen readers can
      // ignore a swap to identical text, such as two approvals in a row.
      window.clearTimeout(restoreTimerRef.current);
      setAnnouncement(null);
      restoreTimerRef.current = window.setTimeout(() => setAnnouncement(message), 100);
    } else if (previous !== null && previous.threadKey !== threadKey) {
      // Drop the last thread's message so it can't be read out on this one.
      window.clearTimeout(restoreTimerRef.current);
      setAnnouncement(null);
    }
  }, [
    threadKey,
    working,
    turnId,
    turnState,
    turnRequestedAt,
    approvalRequestId,
    userInputRequestId,
  ]);

  return (
    <div role="status" aria-atomic="true" className="sr-only">
      {announcement}
    </div>
  );
}
