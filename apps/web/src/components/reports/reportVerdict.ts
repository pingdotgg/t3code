/**
 * What a report is asking of its reader, stated before the prose, and the
 * labeled slots its summary splits into. Both are ported from the PostHog
 * desktop inbox so the two surfaces read a report the same way.
 */
import type { PostHogReport } from "@t3tools/contracts";

/** What kind of moment the report is in. Drives the verdict's color. */
export type ReportVerdictTone = "decision" | "progress" | "info" | "danger";

export interface ReportVerdict {
  readonly tone: ReportVerdictTone;
  /** The state line a reader scans first, e.g. "Needs your decision". */
  readonly title: string;
  /** One sentence: why the report is in this state and what to do. */
  readonly body: string;
}

/**
 * `hasExistingPr` folds in what the report alone cannot know: a conversation
 * about it may already have opened a pull request.
 */
export function deriveReportVerdict(
  report: PostHogReport,
  { hasExistingPr }: { readonly hasExistingPr: boolean },
): ReportVerdict {
  switch (report.status) {
    case "resolved":
      return {
        tone: "info",
        title: "Resolved",
        body: "This report is resolved. Nothing left to do here.",
      };
    case "suppressed":
    case "deleted":
      return {
        tone: "info",
        title: "Archived",
        body: "This report was archived and is kept for reference.",
      };
    case "failed":
      return {
        tone: "danger",
        title: "Run failed",
        body: "The agent could not finish this report. Archive it, or ask what happened.",
      };
    case "pending_input":
      return {
        tone: "decision",
        title: "Waiting on you",
        body: "The agent needs your input before it can continue.",
      };
    case "potential":
    case "candidate":
    case "in_progress":
      return {
        tone: "progress",
        title: "Agent investigating",
        body: "The agent is still gathering evidence. This report updates as findings land.",
      };
    default:
      break;
  }

  if (hasExistingPr) {
    return {
      tone: "decision",
      title: "Review the open PR",
      body: "Implementation is already in flight. Review the pull request, or keep working in the conversation that opened it.",
    };
  }
  if (report.already_addressed === true) {
    return {
      tone: "info",
      title: "Likely already fixed",
      body: "The evidence suggests this was already addressed. Skim the summary and archive the report if you agree.",
    };
  }
  switch (report.actionability) {
    case "immediately_actionable":
      return {
        tone: "decision",
        title: "Needs your decision",
        body: "The agent can fix this with code and open a pull request.",
      };
    case "requires_human_input":
      return {
        tone: "decision",
        title: "Needs your direction",
        body: "A fix needs your call first: business context, trade-offs, or a choice between approaches.",
      };
    case "not_actionable":
      return {
        tone: "info",
        title: "For your awareness",
        body: "No code change follows from this report. Read it, then archive it.",
      };
    default:
      return {
        tone: "decision",
        title: "Ready for review",
        body: "Read the summary and decide what happens next.",
      };
  }
}

export interface ReportSummarySplit {
  /** Prose before the first `##` heading: the summary's own tl;dr. */
  readonly lede: string;
  /** The `##` sections, in document order. */
  readonly sections: ReadonlyArray<{ readonly title: string; readonly body: string }>;
}

/**
 * Split a summary into its labeled slots (Problem, Impact, Solution, ...) so
 * the reader jumps to the one they need. Nothing is cut. Summaries without
 * `##` headings return no sections, and callers render them whole.
 */
export function splitReportSummary(summary: string | null | undefined): ReportSummarySplit {
  if (typeof summary !== "string" || summary.trim().length === 0) {
    return { lede: "", sections: [] };
  }
  const sections: Array<{ title: string; body: string }> = [];
  const lede: Array<string> = [];
  let current: { title: string; body: Array<string> } | null = null;
  for (const line of summary.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading?.[1] !== undefined) {
      if (current) sections.push({ title: current.title, body: current.body.join("\n").trim() });
      current = { title: heading[1], body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      lede.push(line);
    }
  }
  if (current) sections.push({ title: current.title, body: current.body.join("\n").trim() });
  return { lede: lede.join("\n").trim(), sections };
}
