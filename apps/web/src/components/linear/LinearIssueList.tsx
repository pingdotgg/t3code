import type { LinearIssue } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";

import { LinearStateIcon } from "./linearIcons";
import { LinearIssueRow, type LinearIssueRowContext } from "./LinearIssueRow";
import {
  groupLinearIssues,
  topLevelIssues,
  type LinearStatePositions,
} from "./linearIssueList.logic";
import type { LinearGroupBy } from "./linearSearch";

function LinearIssueGroupSection({
  label,
  count,
  stateType,
  stateColor,
  headerless,
  children,
}: {
  label: string;
  count: number;
  stateType: LinearIssue["state"]["type"] | null;
  stateColor: string | undefined;
  headerless: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  if (headerless) return <div className="flex flex-col">{children}</div>;
  return (
    <section className="flex flex-col">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
        className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 transition-transform", collapsed && "-rotate-90")}
        />
        {stateType === null ? null : <LinearStateIcon type={stateType} color={stateColor} />}
        <span>{label}</span>
        <span className="font-normal tabular-nums opacity-80">{count}</span>
      </button>
      {collapsed ? null : children}
    </section>
  );
}

/** Issues grouped by state, milestone, or not at all, with sub-issue trees. */
export function LinearIssueList({
  issues,
  groupBy,
  statePositions,
  context,
}: {
  issues: ReadonlyArray<LinearIssue>;
  groupBy: LinearGroupBy;
  statePositions?: LinearStatePositions;
  context: LinearIssueRowContext;
}) {
  const groups = groupLinearIssues(topLevelIssues(issues), groupBy, statePositions);
  return (
    <div className="flex flex-col gap-1">
      {groups.map((group) => (
        <LinearIssueGroupSection
          key={group.key}
          label={group.label}
          count={group.issues.length}
          stateType={group.stateType}
          stateColor={group.issues[0]?.state.color}
          headerless={groupBy === "none"}
        >
          {group.issues.map((issue) => (
            <LinearIssueRow key={issue.id} issue={issue} context={context} />
          ))}
        </LinearIssueGroupSection>
      ))}
    </div>
  );
}
