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
 * Replaced by the agent's own account of what it needs wherever the caller
 * has it. This is the shape of the ask, never the ask itself.
 */
const NEEDS_A_PERSON: ReportVerdict = {
  tone: "decision",
  title: "Needs you, not an agent",
  body: "The remaining work needs a person — a call the agent cannot make, or a change outside the repository.",
};

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
    // `pending_input` is the same ask as `requires_human_input`, so it falls
    // through to that branch rather than answering with a generic wait.
    case "pending_input":
      break;
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
      title: "Changes are ready to review",
      body: "An implementation is in flight. Read the diff and approve it, or send it back.",
    };
  }
  // A report the agent stopped on is waiting on a person, whatever judgment
  // it recorded when it was written — and it may carry no judgment at all.
  if (report.status === "pending_input") {
    return NEEDS_A_PERSON;
  }
  if (report.already_addressed === true) {
    return {
      tone: "info",
      title: "Already handled",
      // Deliberately thin: the caller replaces this with the agent's own
      // account of what it found, which is the only thing that answers the
      // reader's actual question — is that true?
      body: "The agent found a fix already shipped or in flight.",
    };
  }
  switch (report.actionability) {
    case "immediately_actionable":
      return {
        tone: "decision",
        // Named for what is on offer, not for the reader's obligation: every
        // report in the inbox needs a decision, so saying so says nothing.
        title: "An agent can fix this",
        body: "Implementing checks out a worktree on a new branch, runs your agent, and ends in a pull request. Nothing runs until you say so.",
      };
    case "requires_human_input":
      return NEEDS_A_PERSON;
    case "not_actionable":
      return {
        tone: "info",
        title: "Nothing to do in code",
        body: "No code change follows from this report.",
      };
    default:
      // No actionability judgment landed. Saying "ready" would imply the
      // agent reached a conclusion it never reached.
      return {
        tone: "info",
        title: "Not classified yet",
        body: "No actionability judgment landed on this report, so nothing has decided whether an agent could fix it.",
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

/** What a decision control does when the reader picks it. */
export type ReportActionKind =
  | "implement"
  | "answer"
  | "ask"
  | "review-pr"
  | "open-pr-external"
  | "continue"
  | "archive";

export interface ReportAction {
  readonly kind: ReportActionKind;
  readonly label: string;
}

export interface ReportDecision {
  readonly verdict: ReportVerdict;
  /** The one thing this report is asking for, or null when it asks nothing. */
  readonly primary: ReportAction | null;
  readonly secondary: ReadonlyArray<ReportAction>;
  /**
   * Whether to replace the verdict body with the agent's own justification.
   *
   * True only where the reader cannot act without it: what input is needed,
   * why something is already handled, why nothing follows. Where the action
   * is self-evident — there is a diff to read, there is a fix to authorize —
   * the justification is research notes, and the reader did not ask for them.
   */
  readonly showsReasoning: boolean;
}

const ASK: ReportAction = { kind: "ask", label: "Ask about it" };
const ARCHIVE: ReportAction = { kind: "archive", label: "Archive" };

/**
 * The verbs a report earns, chosen by what it is actually asking. A report
 * that cannot be implemented must not offer to implement, and one waiting on
 * a person must ask them for the answer rather than for a conversation.
 */
export function deriveReportDecision(
  report: PostHogReport,
  { hasExistingPr }: { readonly hasExistingPr: boolean },
): ReportDecision {
  const verdict = deriveReportVerdict(report, { hasExistingPr });

  if (
    report.status === "resolved" ||
    report.status === "suppressed" ||
    report.status === "deleted"
  ) {
    return { verdict, primary: null, secondary: [ASK], showsReasoning: false };
  }
  if (report.status === "failed") {
    return {
      verdict,
      primary: { kind: "ask", label: "Ask what happened" },
      secondary: [ARCHIVE],
      showsReasoning: false,
    };
  }
  if (hasExistingPr) {
    // Reviewing happens here, in the app, with the diff and the approve
    // control. Continuing the agent's conversation is a different job and a
    // rarer one, so it does not get the primary slot.
    return {
      verdict,
      primary: { kind: "review-pr", label: "Review the changes" },
      secondary: [
        { kind: "open-pr-external", label: "Open on GitHub" },
        { kind: "continue", label: "Continue the conversation" },
      ],
      // There is a diff on screen. Why the agent thought so is not the point.
      showsReasoning: false,
    };
  }
  // The agent is still working. Nothing to decide yet, but the reader may
  // still want to steer it.
  if (report.status !== "ready" && report.status !== "pending_input") {
    return { verdict, primary: null, secondary: [ASK, ARCHIVE], showsReasoning: false };
  }
  if (report.status === "pending_input" || report.actionability === "requires_human_input") {
    // Not "send answer": plenty of these are not questions. The reply is
    // optional, so the control opens the conversation either way, and
    // archiving is the honest close once the person has done the thing.
    return {
      verdict,
      primary: { kind: "answer", label: "Reply to the agent" },
      secondary: [{ kind: "archive", label: "I've handled it" }],
      // The explanation is the ask. Without it the reader is told they are
      // needed and not what for.
      showsReasoning: true,
    };
  }
  if (report.already_addressed === true || report.actionability === "not_actionable") {
    // Both are conclusions the reader would otherwise have to go and check.
    return { verdict, primary: ARCHIVE, secondary: [ASK], showsReasoning: true };
  }
  return {
    verdict,
    primary: { kind: "implement", label: "Implement it" },
    secondary: [ASK, ARCHIVE],
    showsReasoning: false,
  };
}
