import type { EnvironmentIssueEntry } from "@t3tools/client-runtime/issue-list";
import { memo } from "react";

import { cn } from "~/lib/utils";
import {
  PullRequestActorAvatar,
  PullRequestLabelChip,
} from "~/components/pullRequest/pullRequestPresentation";

import { nonStatusLabels } from "./boardColumns.logic";

function TrailBoardCardImpl({
  entry,
  selected,
  onSelect,
}: {
  entry: EnvironmentIssueEntry;
  selected: boolean;
  onSelect: (entry: EnvironmentIssueEntry) => void;
}) {
  const chips = nonStatusLabels(entry.labels).slice(0, 3);
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(entry)}
      className={cn(
        "flex w-full flex-col gap-2 rounded-md border border-border/60 bg-card px-3 py-2.5 text-left shadow-xs transition-colors",
        selected ? "border-ring bg-accent" : "hover:bg-accent/50",
      )}
    >
      <div className="flex items-start gap-2">
        <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
          {entry.displayKey}
        </span>
        <span className="min-w-0 flex-1 text-sm font-medium leading-snug">{entry.title}</span>
      </div>
      {(entry.assignees.length > 0 || chips.length > 0) && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {entry.assignees.length > 0 ? (
            <span className="flex items-center -space-x-1">
              {entry.assignees.slice(0, 3).map((assignee) => (
                <PullRequestActorAvatar
                  key={assignee.login}
                  actor={assignee}
                  className="ring-1 ring-background"
                />
              ))}
            </span>
          ) : null}
          {chips.map((label) => (
            <PullRequestLabelChip key={label.name} label={label} />
          ))}
        </div>
      )}
    </button>
  );
}

export const TrailBoardCard = memo(TrailBoardCardImpl);
