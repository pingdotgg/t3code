/**
 * Pure list logic for the report inbox: which section a report belongs to,
 * whether it is unread, and the one-line summary a row shows.
 */
import type { PostHogReport } from "@t3tools/contracts";

export type InboxSection = "needs-you" | "watching" | "done";

/** The sections a report can land in, in reading order. */
export const INBOX_SECTIONS: ReadonlyArray<{
  readonly id: Exclude<InboxSection, "done">;
  readonly label: string;
}> = [
  { id: "needs-you", label: "Needs you" },
  { id: "watching", label: "Watching" },
];

export function inboxSectionForStatus(status: string): InboxSection {
  switch (status) {
    case "ready":
    case "pending_input":
      return "needs-you";
    case "resolved":
    case "suppressed":
    case "deleted":
      return "done";
    default:
      return "watching";
  }
}

/** Human labels for the statuses the inbox shows. Unknown statuses read as themselves. */
const STATE_LABELS: Readonly<Record<string, string>> = {
  ready: "Ready",
  pending_input: "Needs input",
  potential: "Watching",
  candidate: "Candidate",
  in_progress: "Investigating",
  failed: "Failed",
  resolved: "Resolved",
  suppressed: "Archived",
  deleted: "Deleted",
};

export function reportStateLabel(status: string): string {
  return STATE_LABELS[status] ?? status.replace(/_/g, " ");
}

const SENTENCE_END = /[.!?](?=\s|$)/;

/**
 * The first sentence of a summary, with markdown headings and list markers
 * dropped. Report summaries often open with a `##` section, so the lede is
 * whatever prose comes before the first heading.
 */
export function summaryLine(summary: string | null | undefined): string {
  if (typeof summary !== "string") return "";
  const lede = summary.split(/^##\s+/m)[0] ?? "";
  const prose = lede
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
        .replace(/^#+\s*/, "")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .join(" ")
    // Strip the markdown emphasis and link syntax a single line would show raw.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
  if (prose.length === 0) return "";
  const match = SENTENCE_END.exec(prose);
  return match ? prose.slice(0, match.index + 1) : prose;
}

/** `reportId -> the report's `updated_at` when the user last opened it. */
export type ReportSeenMap = Readonly<Record<string, string>>;

export function isReportUnread(report: PostHogReport, seen: ReportSeenMap): boolean {
  const lastSeen = seen[report.id];
  if (lastSeen === undefined) return true;
  return report.updated_at > lastSeen;
}

export interface InboxSectionGroup {
  readonly id: Exclude<InboxSection, "done">;
  readonly label: string;
  readonly reports: ReadonlyArray<PostHogReport>;
}

/** Newest first, matching how the list reads top to bottom. */
function byUpdatedAtDescending(a: PostHogReport, b: PostHogReport): number {
  return b.updated_at.localeCompare(a.updated_at);
}

/** The inbox view: "Needs you" then "Watching", each newest first. */
export function groupInboxReports(
  reports: ReadonlyArray<PostHogReport>,
): ReadonlyArray<InboxSectionGroup> {
  return INBOX_SECTIONS.map((section) => ({
    ...section,
    reports: reports
      .filter((report) => inboxSectionForStatus(report.status) === section.id)
      .sort(byUpdatedAtDescending),
  })).filter((section) => section.reports.length > 0);
}

/** The done view: resolved and archived reports, newest first. */
export function doneReports(reports: ReadonlyArray<PostHogReport>): ReadonlyArray<PostHogReport> {
  return reports
    .filter((report) => inboxSectionForStatus(report.status) === "done")
    .sort(byUpdatedAtDescending);
}

/** The row focus lands on after a report leaves the list. */
export function nextFocusedReportId(
  orderedIds: ReadonlyArray<string>,
  removedId: string,
): string | null {
  const index = orderedIds.indexOf(removedId);
  if (index === -1) return orderedIds[0] ?? null;
  return orderedIds[index + 1] ?? orderedIds[index - 1] ?? null;
}
