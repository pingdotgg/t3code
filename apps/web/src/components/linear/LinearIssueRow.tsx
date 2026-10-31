import type { LinearIssue, LinearIssueActivity } from "@t3tools/contracts";
import { ChevronRightIcon, CornerDownRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";

import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { RelativeTime } from "../RelativeTime";
import { LinearActivityPill } from "./LinearActivityPill";
import { LinearAvatar, LinearPriorityIcon, LinearStateIcon } from "./linearIcons";
import { pickActivityPill } from "@t3tools/client-runtime/linear/activity";
import { linearIssueMatchesRoute } from "@t3tools/client-runtime/linear/issue-link";
import { useLinearSubIssues } from "./useLinearData";

export interface LinearIssueRowContext {
  readonly activityByIssueId: ReadonlyMap<string, LinearIssueActivity>;
  readonly selectedIssueId: string | undefined;
  readonly onSelect: (issueId: string) => void;
}

function LinearLabelChip({ name, color }: { name: string; color: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 pl-1 text-2xs leading-3.75 text-muted-foreground">
      <i aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
      {name}
    </span>
  );
}

export function LinearIssueRow({
  issue,
  depth = 0,
  context,
}: {
  issue: LinearIssue;
  depth?: number;
  context: LinearIssueRowContext;
}) {
  const [expanded, setExpanded] = useState(false);
  const subIssues = useLinearSubIssues(expanded ? issue.id : undefined);
  const selected =
    context.selectedIssueId !== undefined &&
    linearIssueMatchesRoute(issue, context.selectedIssueId);
  const pill = pickActivityPill(issue, context.activityByIssueId.get(issue.id));
  const pullRequest = issue.linkedPullRequests[0];
  const finished = issue.state.type === "completed" || issue.state.type === "canceled";
  const hasChildren = issue.subIssueCount > 0;
  return (
    <>
      <div
        data-linear-issue-id={issue.id}
        data-selected={selected || undefined}
        style={{ marginLeft: depth * 20 }}
        className={cn(
          "relative flex items-center gap-2 rounded-md pl-1 hover:bg-accent/60",
          selected && "bg-primary/9 ring-1 ring-primary/28 ring-inset hover:bg-primary/9",
        )}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? "Collapse sub-issues" : "Expand sub-issues"}
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
            className="inline-flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3 transition-transform", expanded && "rotate-90")}
            />
          </button>
        ) : (
          <span aria-hidden className="size-3.5 shrink-0" />
        )}
        <button
          type="button"
          aria-current={selected || undefined}
          onClick={() => context.onSelect(issue.id)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1.5 pr-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <span className="inline-flex w-4 shrink-0 justify-center">
            <LinearStateIcon type={issue.state.type} color={issue.state.color} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                {issue.identifier}
              </span>
              <span className={cn("min-w-0 truncate text-sm", finished && "text-muted-foreground")}>
                {issue.title}
              </span>
              {hasChildren ? (
                <span className="inline-flex shrink-0 items-center gap-0.5 text-2xs tabular-nums text-muted-foreground">
                  <CornerDownRightIcon aria-hidden className="size-3" />
                  {issue.completedSubIssueCount}/{issue.subIssueCount}
                </span>
              ) : null}
            </span>
            <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs leading-4 text-muted-foreground">
              <LinearPriorityIcon priority={issue.priority} />
              {issue.labels.map((label) => (
                <LinearLabelChip key={label.id} name={label.name} color={label.color} />
              ))}
              {pullRequest ? (
                <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
                  <PullRequestGlyph.pullRequest aria-hidden className="size-3" />#
                  {pullRequest.number}
                </span>
              ) : null}
            </span>
          </span>
          <span className="flex shrink-0 flex-col items-end gap-0.5">
            <span className="flex items-center gap-1.5">
              {pill ? <LinearActivityPill pill={pill} /> : null}
              <LinearAvatar user={issue.assignee} />
            </span>
            <span className="text-2xs tabular-nums text-muted-foreground">
              <RelativeTime timestamp={issue.updatedAt} />
            </span>
          </span>
        </button>
      </div>
      {expanded ? (
        <div className="relative">
          <span
            aria-hidden
            className="absolute top-0 bottom-0 w-px bg-border"
            style={{ left: depth * 20 + 11 }}
          />
          {(subIssues.data ?? []).map((child) => (
            <LinearIssueRow key={child.id} issue={child} depth={depth + 1} context={context} />
          ))}
          {subIssues.data === null && subIssues.error === null ? (
            <p
              className="py-1 text-xs text-muted-foreground"
              style={{ marginLeft: (depth + 1) * 20 + 26 }}
            >
              Loading sub-issues…
            </p>
          ) : null}
          {subIssues.data === null && subIssues.error !== null ? (
            <p
              className="py-1 text-xs text-muted-foreground"
              style={{ marginLeft: (depth + 1) * 20 + 26 }}
            >
              Couldn&apos;t load sub-issues.{" "}
              <button type="button" className="underline" onClick={subIssues.refresh}>
                Retry
              </button>
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
