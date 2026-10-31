import type { LinearIssue, LinearMilestone, LinearStateType } from "@t3tools/contracts";

import { NO_MILESTONE_ID, type LinearGroupBy } from "./search.ts";

/** Issues whose parent is in the same list render nested under it instead of twice. */
export function topLevelIssues(issues: ReadonlyArray<LinearIssue>): ReadonlyArray<LinearIssue> {
  const ids = new Set(issues.map((issue) => issue.id));
  return issues.filter((issue) => issue.parent === null || !ids.has(issue.parent.id));
}

const STATE_TYPE_RANK: Record<LinearStateType, number> = {
  started: 0,
  unstarted: 1,
  triage: 2,
  backlog: 3,
  completed: 4,
  canceled: 5,
};

export interface LinearIssueGroup {
  readonly key: string;
  readonly label: string;
  readonly stateType: LinearStateType | null;
  readonly issues: ReadonlyArray<LinearIssue>;
}

/** Workflow position per state id, when the team's metadata is loaded; orders within a type. */
export type LinearStatePositions = ReadonlyMap<string, number>;

export function groupLinearIssues(
  issues: ReadonlyArray<LinearIssue>,
  groupBy: LinearGroupBy,
  statePositions: LinearStatePositions = new Map(),
): ReadonlyArray<LinearIssueGroup> {
  if (groupBy === "none") {
    return issues.length === 0 ? [] : [{ key: "all", label: "Issues", stateType: null, issues }];
  }
  const groups = new Map<
    string,
    { group: LinearIssueGroup; issues: Array<LinearIssue>; order: number }
  >();
  for (const issue of issues) {
    let key: string;
    let label: string;
    let stateType: LinearStateType | null = null;
    let order: number;
    if (groupBy === "state") {
      key = issue.state.id;
      label = issue.state.name;
      stateType = issue.state.type;
      const position = statePositions.get(issue.state.id) ?? 0;
      // Later workflow steps lead among started states ("In Review" above "In Progress").
      order =
        STATE_TYPE_RANK[issue.state.type] * 1_000 +
        (issue.state.type === "started" ? -position : position);
    } else {
      key = issue.milestone?.id ?? NO_MILESTONE_ID;
      label = issue.milestone?.name ?? "No milestone";
      order = issue.milestone === null ? Number.MAX_SAFE_INTEGER : 0;
    }
    const existing = groups.get(key);
    if (existing) existing.issues.push(issue);
    else {
      const list = [issue];
      groups.set(key, {
        group: { key, label, stateType, issues: list },
        issues: list,
        order,
      });
    }
  }
  return [...groups.values()]
    .sort((a, b) => a.order - b.order || a.group.label.localeCompare(b.group.label))
    .map((entry) => entry.group);
}

/** A project's milestones in Linear's order; completed ones only when shown, but always counted. */
export function listLinearMilestones(
  milestones: ReadonlyArray<LinearMilestone>,
  showCompleted: boolean,
): { readonly visible: ReadonlyArray<LinearMilestone>; readonly completedCount: number } {
  return {
    visible: milestones
      .filter((milestone) => showCompleted || !milestone.completed)
      .sort((a, b) => a.sortOrder - b.sortOrder),
    completedCount: milestones.filter((milestone) => milestone.completed).length,
  };
}

/** "1 issue", "12 issues", or "50+ issues" when Linear's count is capped. */
export function formatLinearIssueCount(count: number, capped: boolean): string {
  if (capped) return `${count}+ issues`;
  return `${count} ${count === 1 ? "issue" : "issues"}`;
}

/** "1 of 5 issues" when a filtered list shows fewer than the total; otherwise the plain total. */
export function formatLinearIssueCountShown(input: {
  readonly shown: number | null;
  readonly total: number;
  readonly capped: boolean;
  readonly truncated?: boolean;
}): string {
  const { shown, total, capped } = input;
  if (shown === null || input.truncated === true || shown >= total) {
    return formatLinearIssueCount(total, capped);
  }
  return `${shown} of ${formatLinearIssueCount(total, capped)}`;
}

export function formatProgressPercent(progress: number): number {
  return Math.round(Math.max(0, Math.min(1, progress)) * 100);
}

function srgbChannelToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Black or white, whichever reads better on a team's hex color (WCAG relative luminance). */
export function linearBadgeTextTone(hexColor: string): "dark" | "light" {
  const digits = hexColor.replace(/^#/u, "");
  const rgb =
    digits.length === 3 || digits.length === 4
      ? digits
          .slice(0, 3)
          .split("")
          .map((digit) => digit + digit)
      : digits.length === 6 || digits.length === 8
        ? [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)]
        : null;
  if (rgb === null) return "light";
  const [red, green, blue] = rgb.map((pair) => srgbChannelToLinear(Number.parseInt(pair, 16)));
  const luminance = 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
  // Above this, black text out-contrasts white.
  return luminance > 0.179 ? "dark" : "light";
}
