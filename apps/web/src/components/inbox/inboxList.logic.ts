/**
 * Pure row-level logic for the report inbox: how a report reads in a row.
 * Which section it lands in lives in `inboxSections.logic.ts`.
 */
import type { PostHogReport } from "@t3tools/contracts";

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

/** PostHog's product keys read as product names, e.g. `error_tracking`. */
const SOURCE_PRODUCT_LABELS: Readonly<Record<string, string>> = {
  error_tracking: "Error tracking",
  session_replay: "Session replay",
  llm_analytics: "AI observability",
  signals_scout: "Scout",
  conversations: "Support",
  health_checks: "Health checks",
};

export function sourceProductLabel(product: string): string {
  return SOURCE_PRODUCT_LABELS[product] ?? product.replace(/_/g, " ");
}

/**
 * Conventional-commit types PostHog's agents write titles with. Only these
 * are stripped: `billing: fix the thing` is a sentence someone wrote, not a
 * commit prefix, and mangling it would be worse than leaving it.
 */
const CONVENTIONAL_PREFIX =
  /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]*\))?!?:\s*/i;

/**
 * A report title read as a brief rather than a commit. The agent writes
 * `fix(tasks): Say which limit was hit`; a reader scanning an inbox wants
 * "Say which limit was hit".
 */
export function humanizeReportTitle(title: string, fallback = "Untitled report"): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) return fallback;
  const stripped = trimmed.replace(CONVENTIONAL_PREFIX, "").trim();
  // Nothing was stripped, so the title is as its author meant it. Only a
  // sentence left headless by removing its prefix gets recapitalized.
  if (stripped === trimmed) return trimmed;
  if (stripped.length === 0) return trimmed;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
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

/** The row focus lands on after a report leaves the list. */
export function nextFocusedReportId(
  orderedIds: ReadonlyArray<string>,
  removedId: string,
): string | null {
  const index = orderedIds.indexOf(removedId);
  if (index === -1) return orderedIds[0] ?? null;
  return orderedIds[index + 1] ?? orderedIds[index - 1] ?? null;
}
