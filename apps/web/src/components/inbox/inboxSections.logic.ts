/**
 * How the inbox divides itself. Sections are ordered and exclusive: a report
 * lands in the first section that keeps it, so no row is read twice.
 *
 * Sections answer one question — whose move is it — and nothing else. Who a
 * report was routed to is a different axis, so it rides on the row and in a
 * filter rather than claiming a section: "for you" spans decisions, reviews,
 * and work in progress, and a section built on it buries all three together.
 *
 * The reader's own sections come before the built-in ones. A section someone
 * defined is deliberate; a default is a guess, and a guess should not swallow
 * the rows a deliberate filter was written to catch.
 */
import type { PostHogInboxFilter, PostHogInboxSection, PostHogReport } from "@t3tools/contracts";

/**
 * What this machine is doing about a report: the half of a report's state
 * PostHog cannot see. A conversation, a worktree, and a running agent are all
 * local facts, and they are what "in flight from my end" means.
 */
export interface ReportWork {
  /** An unarchived conversation about this report exists here. */
  readonly hasThread: boolean;
  /** An agent is running on it right now. */
  readonly isRunning: boolean;
  /** A pull request opened from a conversation here. */
  readonly pullRequestUrl: string | null;
}

export const NO_WORK: ReportWork = { hasThread: false, isRunning: false, pullRequestUrl: null };

export type ReportWorkMap = ReadonlyMap<string, ReportWork>;

export type InboxView = "inbox" | "done";

/** Statuses PostHog uses for a report nobody has archived or resolved. */
// `failed` sits here rather than with the running reports: a run that died is
// not still investigating, and clearing it is a person's job.
const NEEDS_YOU_STATUSES: ReadonlySet<string> = new Set(["ready", "pending_input", "failed"]);
const CLOSED_STATUSES: ReadonlySet<string> = new Set(["resolved", "suppressed", "deleted"]);
const WATCHING_STATUSES: ReadonlySet<string> = new Set(["potential", "candidate", "in_progress"]);

export function isClosedReport(report: PostHogReport): boolean {
  return CLOSED_STATUSES.has(report.status);
}

/**
 * A report the agent judged nothing can be done about. PostHog's own inbox
 * keeps these off the Reports tab and behind a staff-only one, so they are
 * hidden here too unless the reader asks for them.
 *
 * A report with no actionability judgment yet is not this: it is unjudged,
 * which is why the filter lives here rather than on the request, where an
 * absent judgment would be excluded along with an explicit `not_actionable`.
 */
export function isNotActionable(report: PostHogReport): boolean {
  return report.actionability === "not_actionable";
}

/**
 * The authoring agent judged that a fix has already landed or is in flight.
 * PostHog uses this to withhold autonomous pull requests, not to close the
 * report: `already_addressed` is a finding, while Done is a state a person set.
 */
export function isAlreadyHandled(report: PostHogReport): boolean {
  return report.already_addressed === true;
}

function hasReportPullRequest(report: PostHogReport): boolean {
  return (
    typeof report.implementation_pr_url === "string" && report.implementation_pr_url.length > 0
  );
}

/**
 * Every field narrows. An empty array or an absent flag does not filter, so
 * an empty filter keeps everything — which is what a section the reader has
 * not finished defining should do.
 */
export function matchesFilter(report: PostHogReport, filter: PostHogInboxFilter): boolean {
  if (filter.statuses.length > 0 && !filter.statuses.includes(report.status)) return false;
  if (filter.priorities.length > 0) {
    if (report.priority == null || !filter.priorities.includes(report.priority)) return false;
  }
  if (filter.actionabilities.length > 0) {
    if (report.actionability == null || !filter.actionabilities.includes(report.actionability)) {
      return false;
    }
  }
  if (filter.sourceProducts.length > 0) {
    if (!report.source_products.some((product) => filter.sourceProducts.includes(product))) {
      return false;
    }
  }
  if (filter.forYou === true && report.is_suggested_reviewer !== true) return false;
  if (filter.forYou === false && report.is_suggested_reviewer === true) return false;
  if (filter.hasPullRequest != null && hasReportPullRequest(report) !== filter.hasPullRequest) {
    return false;
  }
  if (filter.alreadyAddressed != null) {
    if ((report.already_addressed === true) !== filter.alreadyAddressed) return false;
  }
  const needle = filter.titleContains.trim().toLowerCase();
  if (needle.length > 0 && !report.title.toLowerCase().includes(needle)) return false;
  return true;
}

/** True when a filter narrows nothing, so the UI can warn before it saves one. */
export function isEmptyFilter(filter: PostHogInboxFilter): boolean {
  return (
    filter.statuses.length === 0 &&
    filter.priorities.length === 0 &&
    filter.actionabilities.length === 0 &&
    filter.sourceProducts.length === 0 &&
    filter.forYou == null &&
    filter.hasPullRequest == null &&
    filter.alreadyAddressed == null &&
    filter.titleContains.trim().length === 0
  );
}

export interface InboxSectionDefinition {
  readonly id: string;
  readonly label: string;
  /** What the section is for, shown while editing and when it is empty. */
  readonly description: string;
  readonly builtIn: boolean;
  /** Sections that are not asking anything of the reader open folded. */
  readonly defaultCollapsed?: boolean;
  readonly keeps: (report: PostHogReport, work: ReportWork) => boolean;
}

/**
 * The sections that exist without anyone configuring anything, ordered by
 * whose move it is: yours, then the reviewer's, then an agent's, then
 * nobody's.
 */
export const BUILT_IN_SECTIONS: ReadonlyArray<InboxSectionDefinition> = [
  {
    id: "needs-you",
    label: "Needs you",
    description: "Waiting on a decision or an answer from you, with nothing in flight.",
    builtIn: true,
    keeps: (report, work) =>
      NEEDS_YOU_STATUSES.has(report.status) &&
      !hasReportPullRequest(report) &&
      work.pullRequestUrl === null &&
      !work.hasThread &&
      !isAlreadyHandled(report) &&
      !isNotActionable(report),
  },
  {
    id: "in-review",
    label: "In review",
    description: "A pull request is open — read the diff.",
    builtIn: true,
    keeps: (report, work) => hasReportPullRequest(report) || work.pullRequestUrl !== null,
  },
  {
    id: "working",
    label: "You're working on it",
    description: "You have a conversation or a worktree open on these.",
    builtIn: true,
    keeps: (_report, work) => work.hasThread,
  },
  {
    id: "agent-working",
    label: "PostHog is still investigating",
    description: "The agent is still gathering evidence. Nothing is asked of you yet.",
    builtIn: true,
    defaultCollapsed: true,
    keeps: (report) => WATCHING_STATUSES.has(report.status),
  },
  {
    id: "not-actionable",
    label: "Nothing to do",
    description: "The agent judged that no code change follows from these.",
    builtIn: true,
    defaultCollapsed: true,
    keeps: isNotActionable,
  },
  {
    id: "already-handled",
    label: "Already handled",
    description: "The agent found a fix already shipped or in flight.",
    builtIn: true,
    // PostHog keeps filing these on purpose — a team wants to know the issue
    // is real and being handled. It is not a decision, so it does not sit
    // among the decisions; it opens folded and stays out of triage.
    defaultCollapsed: true,
    keeps: isAlreadyHandled,
  },
];

export function customSectionDefinition(section: PostHogInboxSection): InboxSectionDefinition {
  return {
    id: section.id,
    label: section.label,
    description: "Your section.",
    builtIn: false,
    keeps: (report) => matchesFilter(report, section.filter),
  };
}

/**
 * What this machine is doing about each report, keyed by report id. Typed
 * structurally rather than against `ThreadShell` so this module stays pure
 * and testable without the client's thread model.
 */
export interface ReportWorkThread {
  readonly reportId?: string | null | undefined;
  readonly archivedAt?: string | null | undefined;
  readonly session?: { readonly status?: string } | null | undefined;
  readonly linkedPullRequest?: { readonly url?: string } | null | undefined;
}

export function buildReportWork(threads: ReadonlyArray<ReportWorkThread>): ReportWorkMap {
  const work = new Map<string, ReportWork>();
  for (const thread of threads) {
    const reportId = thread.reportId;
    if (typeof reportId !== "string" || reportId.length === 0) continue;
    if (thread.archivedAt != null) continue;
    const current = work.get(reportId) ?? NO_WORK;
    work.set(reportId, {
      hasThread: true,
      isRunning: current.isRunning || thread.session?.status === "running",
      pullRequestUrl: current.pullRequestUrl ?? thread.linkedPullRequest?.url ?? null,
    });
  }
  return work;
}

/**
 * The reader's sections first, then the built-ins. A section someone wrote
 * outranks a default, or a custom "My P0s" would never see a row that
 * "Needs a decision" had already claimed.
 */
export function orderedSectionDefinitions(
  customSections: ReadonlyArray<PostHogInboxSection>,
): ReadonlyArray<InboxSectionDefinition> {
  return [...customSections.map(customSectionDefinition), ...BUILT_IN_SECTIONS];
}

/** Whose reports the inbox is showing. Spans every section rather than being one. */
export type InboxScope = "for-you" | "everyone";

export interface InboxSectionOptions {
  readonly showNotActionable?: boolean;
  readonly scope?: InboxScope;
  /** What this machine is doing about each report. */
  readonly work?: ReportWorkMap;
}

export interface InboxSectionGroup {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly builtIn: boolean;
  readonly defaultCollapsed: boolean;
  readonly reports: ReadonlyArray<PostHogReport>;
}

/** Newest first, matching how the list reads top to bottom. */
function byUpdatedAtDescending(a: PostHogReport, b: PostHogReport): number {
  return b.updated_at.localeCompare(a.updated_at);
}

/**
 * Group the open reports. Anything no section kept falls into "Everything
 * else" rather than disappearing: a report the reader cannot see is a report
 * they cannot archive.
 */
export function buildInboxSections(
  reports: ReadonlyArray<PostHogReport>,
  customSections: ReadonlyArray<PostHogInboxSection>,
  { showNotActionable = false, scope = "everyone", work }: InboxSectionOptions = {},
): ReadonlyArray<InboxSectionGroup> {
  const definitions = orderedSectionDefinitions(customSections);
  const buckets = new Map<string, Array<PostHogReport>>(
    definitions.map((definition) => [definition.id, []]),
  );
  const remainder: Array<PostHogReport> = [];

  for (const report of reports) {
    if (isClosedReport(report)) continue;
    if (!showNotActionable && isNotActionable(report)) continue;
    // Scope narrows every section at once. A report you are already working
    // on stays in view whoever it was routed to: your own work is yours.
    const reportWork = work?.get(report.id) ?? NO_WORK;
    if (scope === "for-you" && report.is_suggested_reviewer !== true && !reportWork.hasThread) {
      continue;
    }
    const owner = definitions.find((definition) => definition.keeps(report, reportWork));
    if (owner === undefined) {
      remainder.push(report);
      continue;
    }
    buckets.get(owner.id)?.push(report);
  }

  const groups = definitions.map((definition) => ({
    id: definition.id,
    label: definition.label,
    description: definition.description,
    builtIn: definition.builtIn,
    defaultCollapsed: definition.defaultCollapsed ?? false,
    reports: (buckets.get(definition.id) ?? []).sort((a, b) => {
      // A running agent is the most live thing on the page; it leads.
      const running =
        Number(work?.get(b.id)?.isRunning ?? false) - Number(work?.get(a.id)?.isRunning ?? false);
      return running !== 0 ? running : byUpdatedAtDescending(a, b);
    }),
  }));

  if (remainder.length > 0) {
    groups.push({
      id: "everything-else",
      label: "Everything else",
      description: "Reports no section claimed.",
      builtIn: true,
      defaultCollapsed: false,
      reports: remainder.sort(byUpdatedAtDescending),
    });
  }
  return groups;
}

/** The Done view is one section: resolved and archived reports, newest first. */
export function buildDoneSections(
  reports: ReadonlyArray<PostHogReport>,
): ReadonlyArray<InboxSectionGroup> {
  return [
    {
      id: "done",
      label: "Done",
      description: "Resolved and archived.",
      builtIn: true,
      defaultCollapsed: false,
      reports: reports.filter(isClosedReport).sort(byUpdatedAtDescending),
    },
  ];
}

/**
 * How many rows a section shows before asking. Long enough to be worth
 * scanning, short enough that four sections still fit a screen.
 */
export const SECTION_PAGE_SIZE = 10;

export interface VisibleSectionReports {
  readonly visible: ReadonlyArray<PostHogReport>;
  readonly hiddenCount: number;
  /** How many the next reveal would add, so the control can say so. */
  readonly nextRevealCount: number;
}

/**
 * The rows a section actually renders. Revealing happens a page at a time
 * rather than all at once: a section holding hundreds of reports should not
 * become hundreds of rows because someone wanted to see the eleventh.
 */
export function visibleSectionReports(
  reports: ReadonlyArray<PostHogReport>,
  limit: number = SECTION_PAGE_SIZE,
): VisibleSectionReports {
  const capped = Math.max(0, limit);
  if (reports.length <= capped) {
    return { visible: reports, hiddenCount: 0, nextRevealCount: 0 };
  }
  const hiddenCount = reports.length - capped;
  return {
    visible: reports.slice(0, capped),
    hiddenCount,
    nextRevealCount: Math.min(hiddenCount, SECTION_PAGE_SIZE),
  };
}

/** A section id that will not collide with a built-in or an existing custom one. */
export function nextCustomSectionId(existing: ReadonlyArray<PostHogInboxSection>): string {
  const taken = new Set([
    ...BUILT_IN_SECTIONS.map((section) => section.id),
    "everything-else",
    ...existing.map((section) => section.id),
  ]);
  let index = existing.length + 1;
  while (taken.has(`section-${index}`)) index += 1;
  return `section-${index}`;
}

export const EMPTY_INBOX_FILTER: PostHogInboxFilter = {
  statuses: [],
  priorities: [],
  actionabilities: [],
  sourceProducts: [],
  forYou: null,
  hasPullRequest: null,
  alreadyAddressed: null,
  titleContains: "",
};
