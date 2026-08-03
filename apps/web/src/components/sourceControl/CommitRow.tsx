/**
 * One commit in the history list.
 *
 * The lane node is a prop, not a derivation — see `LaneGraph.tsx`. The row's
 * height comes from `historyCommitRowHeight(density, width)` and is applied
 * explicitly so the rendered pitch equals the pitch the virtualizer assumed.
 *
 * fork: f4 source-control panel
 */
import type { WorkingCopyLogEntry } from "@t3tools/contracts";
import { memo } from "react";

import {
  historyCommitRowHeight,
  type HistoryDensity,
  type HistoryWidth,
} from "~/lib/sourceControl/historyRows";
import type { LaneNode } from "~/lib/sourceControl/laneGraph";
import { cn } from "~/lib/utils";

import { CommitContextMenu, type CommitContextMenuProps } from "./CommitContextMenu";
import { LaneGraphRow, laneGutterPixelWidth } from "./LaneGraph";
import { historyRowElements } from "./sourceControlPanel.logic";

interface CommitRowProps extends Omit<CommitContextMenuProps, "entry"> {
  readonly entry: WorkingCopyLogEntry;
  readonly node: LaneNode | null;
  readonly graphWidth: number;
  readonly density: HistoryDensity;
  readonly width: HistoryWidth;
  readonly selected: boolean;
  readonly onToggleDrawer: (hash: string) => void;
}

function CommitRowImpl(props: CommitRowProps) {
  const { entry } = props;
  const height = historyCommitRowHeight(props.density, props.width);
  const elements = historyRowElements(props.width);
  const isMerge = entry.parents.length > 1;

  return (
    <div
      style={{ height }}
      className={cn(
        "group flex cursor-default items-stretch gap-2 pr-1.5 text-sm",
        props.selected ? "bg-accent" : "hover:bg-accent/50",
      )}
      onClick={() => props.onToggleDrawer(entry.hash)}
      role="option"
      aria-selected={props.selected}
    >
      {props.node ? (
        <div style={{ width: laneGutterPixelWidth(props.graphWidth) }} className="shrink-0">
          <LaneGraphRow
            node={props.node}
            width={props.graphWidth}
            height={height}
            isMerge={isMerge}
          />
        </div>
      ) : (
        <span className="w-2 shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <span className="truncate leading-tight">{entry.subject}</span>
        {elements.twoLine ? (
          <span className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs leading-tight">
            {elements.shortHash ? (
              <span className="shrink-0 font-mono">{entry.shortHash}</span>
            ) : null}
            {elements.authorName ? <span className="truncate">{entry.authorName}</span> : null}
            <time className="ml-auto shrink-0" dateTime={entry.authoredAt}>
              {shortDate(entry.authoredAt)}
            </time>
          </span>
        ) : null}
      </div>
      {!elements.twoLine && elements.shortHash ? (
        <span className="shrink-0 self-center font-mono text-muted-foreground text-xs">
          {entry.shortHash}
        </span>
      ) : null}
      <span className="hidden shrink-0 items-center self-center group-hover:flex">
        <CommitContextMenu {...props} entry={entry} />
      </span>
    </div>
  );
}

function shortDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const CommitRow = memo(CommitRowImpl);
