/**
 * One commit in the history list.
 *
 * The lane node is a prop, not a derivation — see `LaneGraph.tsx`. The row's
 * height comes from `historyCommitRowHeight(density, width)` and is applied
 * explicitly so the rendered pitch equals the pitch the virtualizer assumed.
 *
 * fork: f4 redesign (audit §8 E) — the `⋯` menu used to be `hidden
 * group-hover:flex`, i.e. absent from the DOM and from the a11y tree until a
 * mouse arrived, which on a touch device meant the entire per-commit action set
 * did not exist. It is mounted always now and only its opacity changes.
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
import { historyRowElements, type HistoryRowDate } from "./sourceControlPanel.logic";

interface CommitRowProps extends Omit<CommitContextMenuProps, "entry"> {
  readonly entry: WorkingCopyLogEntry;
  readonly node: LaneNode | null;
  readonly graphWidth: number;
  readonly density: HistoryDensity;
  readonly width: HistoryWidth;
  readonly selected: boolean;
  /** fork: f4 redesign (M9) — the listbox points `aria-activedescendant` here. */
  readonly domId: string;
  readonly focused: boolean;
  readonly onToggleDrawer: (hash: string) => void;
}

function CommitRowImpl(props: CommitRowProps) {
  const { entry } = props;
  const height = historyCommitRowHeight(props.density, props.width);
  const elements = historyRowElements(props.width);
  const isMerge = entry.parents.length > 1;
  const date = formatHistoryDate(entry.authoredAt, elements.date);

  return (
    <div
      id={props.domId}
      style={{ height }}
      className={cn(
        "group flex cursor-default items-stretch gap-2 pr-3 text-sm",
        props.selected ? "bg-accent" : "hover:bg-accent/50",
        props.focused && "inset-ring-1 inset-ring-ring",
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
        <span className="w-3 shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <span className="truncate leading-tight">{entry.subject}</span>
        {elements.twoLine ? (
          <span className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs leading-tight">
            {elements.shortHash ? (
              <span className="shrink-0 font-mono">{entry.shortHash}</span>
            ) : null}
            {elements.authorName ? <span className="truncate">{entry.authorName}</span> : null}
            {date === null ? null : (
              <time className="ml-auto shrink-0 tabular-nums" dateTime={entry.authoredAt}>
                {date}
              </time>
            )}
          </span>
        ) : null}
      </div>
      {!elements.twoLine && elements.shortHash ? (
        <span className="shrink-0 self-center font-mono text-muted-foreground text-xs">
          {entry.shortHash}
        </span>
      ) : null}
      <span
        className={cn(
          "flex shrink-0 items-center self-center opacity-0 transition-opacity",
          "group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100",
          props.selected && "opacity-100",
        )}
      >
        <CommitContextMenu {...props} entry={entry} />
      </span>
    </div>
  );
}

/**
 * The date form the width ladder asked for. `null` at `xs`, where the row is a
 * single line and the subject gets all of it.
 */
function formatHistoryDate(iso: string, form: HistoryRowDate): string | null {
  if (form === "none") return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  if (form === "relative") {
    return relativeDate(at);
  }
  if (form === "day") {
    return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return at.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function relativeDate(at: Date): string {
  const minutes = Math.round((Date.now() - at.getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const CommitRow = memo(CommitRowImpl);
