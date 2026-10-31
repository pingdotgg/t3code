import {
  groupLinearIssues,
  topLevelIssues,
  type LinearStatePositions,
} from "@t3tools/client-runtime/linear/issue-list";
import type { LinearGroupBy } from "@t3tools/client-runtime/linear/search";
import type { LinearIssue, LinearStateType } from "@t3tools/contracts";

export type LinearIssueListItem =
  | {
      readonly type: "header";
      readonly key: string;
      readonly label: string;
      readonly count: number;
      readonly stateType: LinearStateType | null;
      readonly stateColor: string | undefined;
      readonly collapsed: boolean;
    }
  | { readonly type: "issue"; readonly key: string; readonly issue: LinearIssue };

/**
 * Flat rows for a virtualized list: a header per group (none when ungrouped) followed by its
 * issues, which a collapsed group omits. Sub-issues whose parent is listed render under it.
 */
export function linearIssueListItems(
  issues: ReadonlyArray<LinearIssue>,
  groupBy: LinearGroupBy,
  statePositions: LinearStatePositions,
  collapsed: ReadonlySet<string>,
): ReadonlyArray<LinearIssueListItem> {
  const items: Array<LinearIssueListItem> = [];
  for (const group of groupLinearIssues(topLevelIssues(issues), groupBy, statePositions)) {
    const isCollapsed = collapsed.has(group.key);
    if (groupBy !== "none") {
      items.push({
        type: "header",
        key: `group:${group.key}`,
        label: group.label,
        count: group.issues.length,
        stateType: group.stateType,
        stateColor: group.issues[0]?.state.color,
        collapsed: isCollapsed,
      });
    }
    if (isCollapsed) continue;
    for (const issue of group.issues) items.push({ type: "issue", key: issue.id, issue });
  }
  return items;
}
