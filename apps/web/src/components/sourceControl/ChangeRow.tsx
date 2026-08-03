/**
 * One file row in the changes list.
 *
 * The row's pitch is NOT decided here: it is `CHANGES_ROW_HEIGHT.file` (plus
 * the conflict bar when present), applied as an explicit height so the rendered
 * pitch and the pitch the virtualizer assumed cannot drift. A wrong pitch
 * drifts the window silently, which is the worst kind of layout bug.
 *
 * fork: f4 source-control panel
 */
import { Minus, Plus, Undo2 } from "lucide-react";
import { memo } from "react";

import { CHANGES_ROW_HEIGHT, CONFLICT_ACTIONS_HEIGHT } from "~/lib/sourceControl/changesRows";
import type { ChangesRow } from "~/lib/sourceControl/changesRows";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { changeLabel, changeLetter, splitDisplayPath } from "./sourceControlPanel.logic";

const LETTER_TONE: Record<string, string> = {
  A: "text-emerald-500",
  M: "text-amber-500",
  D: "text-destructive-foreground",
  R: "text-sky-500",
  C: "text-sky-500",
  U: "text-muted-foreground",
  T: "text-amber-500",
  "!": "text-destructive-foreground",
};

export interface ChangeRowActions {
  readonly onStage: (row: ChangesRow) => void;
  readonly onUnstage: (row: ChangesRow) => void;
  readonly onDiscard: (row: ChangesRow) => void;
  readonly onResolve: (row: ChangesRow, side?: "ours" | "theirs") => void;
  readonly onOpen: (row: ChangesRow) => void;
  readonly onSelect: (row: ChangesRow, event: React.MouseEvent) => void;
}

interface ChangeRowProps extends ChangeRowActions {
  readonly row: ChangesRow;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly partial: boolean;
  readonly busy: boolean;
  readonly indentPx: number;
}

function ChangeRowImpl(props: ChangeRowProps) {
  const { row } = props;
  const file = row.file;
  if (!file) return null;
  const { name, dir } = splitDisplayPath(file.path);
  const letter = changeLetter(file.change);
  const conflicted = row.group === "conflicted";
  const staged = row.group === "staged";

  return (
    <div
      className="flex flex-col"
      data-source-control-row={row.key}
      aria-selected={props.selected}
      role="option"
    >
      <div
        style={{ height: CHANGES_ROW_HEIGHT.file, paddingLeft: 8 + props.indentPx }}
        className={cn(
          "group flex items-center gap-2 pr-1.5 text-sm",
          props.selected ? "bg-accent" : "hover:bg-accent/50",
          props.focused && "inset-ring-1 inset-ring-ring/60",
          props.busy && "opacity-64",
        )}
        onClick={(event) => props.onSelect(row, event)}
        onDoubleClick={() => props.onOpen(row)}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className={cn(
                  "w-3 shrink-0 text-center font-mono text-xs",
                  LETTER_TONE[letter] ?? "text-muted-foreground",
                )}
              >
                {letter}
              </span>
            }
          />
          <TooltipPopup>{changeLabel(file.change)}</TooltipPopup>
        </Tooltip>
        <span className="min-w-0 flex-1 truncate">
          <span className="text-foreground">{name}</span>
          {dir ? <span className="ml-1.5 text-muted-foreground text-xs">{dir}</span> : null}
        </span>
        {props.partial ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px] text-muted-foreground">
                  partial
                </span>
              }
            />
            <TooltipPopup>Some changes to this file are staged and some are not.</TooltipPopup>
          </Tooltip>
        ) : null}
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums group-hover:hidden">
          {file.insertions !== undefined || file.deletions !== undefined ? (
            <>
              <span className="text-emerald-500">+{file.insertions ?? 0}</span>{" "}
              <span className="text-destructive-foreground">−{file.deletions ?? 0}</span>
            </>
          ) : null}
        </span>
        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          {staged ? (
            <RowAction label="Unstage" onClick={() => props.onUnstage(row)}>
              <Minus className="size-3.5" />
            </RowAction>
          ) : (
            <RowAction label="Stage" onClick={() => props.onStage(row)}>
              <Plus className="size-3.5" />
            </RowAction>
          )}
          {!staged && !conflicted ? (
            <RowAction label="Discard" onClick={() => props.onDiscard(row)}>
              <Undo2 className="size-3.5" />
            </RowAction>
          ) : null}
        </span>
      </div>
      {conflicted ? (
        <div
          style={{ height: CONFLICT_ACTIONS_HEIGHT, paddingLeft: 8 + props.indentPx }}
          className="flex items-center gap-1.5 pr-1.5 text-xs"
        >
          <button
            type="button"
            className="rounded-sm border border-border px-1.5 py-0.5 hover:bg-accent"
            onClick={() => props.onResolve(row, "ours")}
          >
            Accept current
          </button>
          <button
            type="button"
            className="rounded-sm border border-border px-1.5 py-0.5 hover:bg-accent"
            onClick={() => props.onResolve(row, "theirs")}
          >
            Accept incoming
          </button>
          <button
            type="button"
            className="rounded-sm border border-border px-1.5 py-0.5 hover:bg-accent"
            onClick={() => props.onResolve(row)}
          >
            Mark resolved
          </button>
        </div>
      ) : null}
    </div>
  );
}

function RowAction(props: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              props.onClick();
            }}
          >
            {props.children}
          </button>
        }
      />
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export const ChangeRow = memo(ChangeRowImpl);
