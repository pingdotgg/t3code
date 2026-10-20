export const THREAD_SWIPE_ACTION_CHOICES = [
  "settle",
  "snooze",
  "archive",
  "delete",
  "none",
] as const;

export type ThreadSwipeActionChoice = (typeof THREAD_SWIPE_ACTION_CHOICES)[number];

export const DEFAULT_THREAD_SWIPE_LEADING_ACTION: ThreadSwipeActionChoice = "snooze";
export const DEFAULT_THREAD_SWIPE_TRAILING_ACTION: ThreadSwipeActionChoice = "settle";

export function isThreadSwipeActionChoice(value: unknown): value is ThreadSwipeActionChoice {
  return (THREAD_SWIPE_ACTION_CHOICES as readonly unknown[]).includes(value);
}
