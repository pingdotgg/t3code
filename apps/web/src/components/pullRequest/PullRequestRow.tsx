import type { PullRequestListEntry } from "@t3tools/contracts";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import {
  PullRequestActorLabel,
  PullRequestDiffStat,
  PullRequestStateGlyph,
} from "./pullRequestPresentation";

function PullRequestRowImpl({
  entry,
  selected,
  onSelect,
}: {
  readonly entry: PullRequestListEntry;
  readonly selected: boolean;
  readonly onSelect: (entry: PullRequestListEntry) => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      className={cn(
        "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-2 text-left [content-visibility:auto] [contain-intrinsic-block-size:54px]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
      onClick={() => onSelect(entry)}
    >
      <PullRequestStateGlyph
        isDraft={entry.isDraft}
        mergeability={entry.mergeability}
        state={entry.state}
      />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{entry.title}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0">#{entry.number}</span>
          <span className="truncate">{entry.repository}</span>
          <PullRequestActorLabel actor={entry.author} className="max-w-30 shrink-0" />
        </span>
      </span>
      <span className="flex flex-col items-end gap-0.5 text-xs text-muted-foreground">
        <span>{formatRelativeTimeLabel(entry.updatedAt)}</span>
        <PullRequestDiffStat additions={entry.additions} deletions={entry.deletions} />
      </span>
    </button>
  );
}

export const PullRequestRow = memo(PullRequestRowImpl);
