import {
  activityAnnouncementMessages,
  type ActivityAnnouncementState,
} from "@t3tools/client-runtime/activity-announcement";

/** What a screen reader user should hear about the thread they are viewing. */
export interface ThreadActivityAnnouncementState extends ActivityAnnouncementState {
  readonly connected: boolean;
  readonly environmentLabel: string | null;
}

/**
 * The status message for a change between two renders, or null when nothing
 * worth speaking changed. Adds connection changes to the shared agent
 * activity messages; changes that land together are joined so one
 * announcement doesn't cut off another.
 */
export function threadActivityAnnouncement(
  previous: ThreadActivityAnnouncementState | null,
  next: ThreadActivityAnnouncementState,
): string | null {
  if (previous === null || previous.threadKey !== next.threadKey) return null;

  const messages: string[] = [];
  const environmentLabel = next.environmentLabel ?? "environment";
  if (previous.connected && !next.connected) {
    messages.push(`Disconnected from ${environmentLabel}`);
  } else if (!previous.connected && next.connected) {
    messages.push(`Connected to ${environmentLabel}`);
  }
  messages.push(...activityAnnouncementMessages(previous, next));

  return messages.length > 0 ? messages.join(". ") : null;
}
