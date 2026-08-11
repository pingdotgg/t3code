import type { DesktopNotificationKind } from "@t3tools/contracts";

/** Notification titles. The kind leads, so the banner is scannable at a glance. */
const NOTIFICATION_TITLES: Readonly<Record<DesktopNotificationKind, string>> = {
  "task-completed": "Completed",
  "task-failed": "Failed",
  "approval-needed": "Approval Required",
};

export function notificationTitle(kind: DesktopNotificationKind): string {
  return NOTIFICATION_TITLES[kind];
}

/** macOS elides past roughly two lines; this also keeps the IPC payload small. */
const MAX_BODY_LENGTH = 180;

/**
 * Flattens assistant markdown into the plain text a notification can render.
 *
 * Notification bodies are plain text: any markdown that survives shows up as
 * literal `**` and backticks in the banner. This strips the syntax rather than
 * the content, so the reader sees the sentence the agent wrote.
 *
 * Deliberately regex-based and not a full markdown parser: this runs on the
 * notification path for a single leading excerpt, and pulling a parser in for
 * it would cost far more than the fidelity is worth.
 */
export function toPlainNotificationText(markdown: string): string {
  let text = markdown;

  // Fenced code blocks: keep a marker rather than dumping code into a banner.
  text = text.replace(/```[\s\S]*?```/g, " (code) ");
  text = text.replace(/~~~[\s\S]*?~~~/g, " (code) ");

  // Images before links: the image syntax is a link with a leading `!`.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // Inline code, bold, italic, strikethrough. Emphasis runs last so `**x**`
  // is not half-consumed by the single-character rules.
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2");

  // Block syntax at line starts: headings, quotes, list bullets, tasks.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s{0,3}>\s?/gm, "");
  text = text.replace(/^\s{0,3}[-*+]\s+\[[ xX]\]\s+/gm, "");
  text = text.replace(/^\s{0,3}[-*+]\s+/gm, "");
  text = text.replace(/^\s{0,3}\d+\.\s+/gm, "");
  // Horizontal rules, once their characters can no longer read as emphasis.
  text = text.replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, " ");

  // HTML comments, then any remaining tags.
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<[^>]+>/g, "");

  // Collapse all whitespace: a banner is one flowing line, so newlines from
  // the original layout would otherwise leave ragged gaps.
  return text.replace(/\s+/g, " ").trim();
}

export function truncateNotificationBody(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_BODY_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_BODY_LENGTH - 1).trimEnd()}…`;
}

/**
 * Body text for a notification: the start of what the agent actually said,
 * falling back to the thread title when no response text is available (the
 * thread was never opened this session, so its messages are not in memory).
 */
export function notificationBody(input: {
  readonly responseText: string | null;
  readonly threadTitle: string;
  readonly fallbackHeadline: string;
}): string {
  const plain = input.responseText === null ? "" : toPlainNotificationText(input.responseText);
  if (plain.length > 0) {
    return truncateNotificationBody(plain);
  }
  const title = input.threadTitle.trim();
  return truncateNotificationBody(title.length > 0 ? title : input.fallbackHeadline);
}
