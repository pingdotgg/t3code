/**
 * One file row in the changes list.
 *
 * The row's pitch is NOT decided here: it is `CHANGES_ROW_HEIGHT.file` (plus
 * the conflict bar when present), applied as an explicit height so the rendered
 * pitch and the pitch the virtualizer assumed cannot drift. A wrong pitch
 * drifts the window silently, which is the worst kind of layout bug.
 *
 * fork: f4 redesign — three structural changes here:
 *
 *  1. ONE gutter. The left inset is `changesRowIndent(depth)`, the same
 *     12 + 12·depth every other row, header and band in the panel uses.
 *  2. Actions overlay the trailing metadata instead of permanently taxing
 *     every filename by 24–48px. The overlay is always mounted and only changes
 *     opacity, so hover never shifts the row.
 *  3. House primitives. `Button size="icon-xs"` brings the focus ring, the 44px
 *     `pointer-coarse` target and `disabled:opacity-64`; `DiffStatLabel` brings
 *     the fixed `4ch_4ch` grid that stops the right edge from jittering.
 *
 * fork: f4 source-control panel
 */
import { FileIcon, Loader2, Minus, Plus, Undo2 } from "lucide-react";
import { memo } from "react";

import { CHANGES_ROW_HEIGHT, CONFLICT_ACTIONS_HEIGHT } from "~/lib/sourceControl/changesRows";
import type { ChangesRow } from "~/lib/sourceControl/changesRows";
import { Button } from "~/components/ui/button";
import { DiffStatLabel } from "~/components/chat/DiffStatLabel";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { PathLabel } from "./PathLabel";
import { changeLabel, changeLetter, splitDisplayPath } from "./sourceControlPanel.logic";

/**
 * fork: f4 redesign (audit §8 / M11) — the status letter's tone, on the token
 * pairs that have a dark variant. These were bare `text-emerald-500` /
 * `text-amber-500` / `text-sky-500`, which is ~2.2:1 on the light background
 * and has no dark counterpart at all.
 */
const LETTER_TONE: Record<string, string> = {
  A: "text-success-foreground",
  M: "text-warning-foreground",
  D: "text-destructive-foreground",
  R: "text-info-foreground",
  C: "text-info-foreground",
  U: "text-muted-foreground",
  T: "text-warning-foreground",
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
  /** An action on THIS file's path is in flight — every rung below disables. */
  readonly busy: boolean;
  /** Flat mode needs directory context; tree mode already renders it as ancestors. */
  readonly showDirectory: boolean;
  readonly indentPx: number;
  readonly domId: string;
}

function ChangeRowImpl(props: ChangeRowProps) {
  const { row } = props;
  const file = row.file;
  if (!file) return null;
  const { name, dir } = splitDisplayPath(file.path);
  const letter = changeLetter(file.change);
  const conflicted = row.group === "conflicted";
  const staged = row.group === "staged";
  const hasStat = file.insertions !== undefined || file.deletions !== undefined;

  return (
    <div
      className="flex flex-col"
      // fork: f4 focus model — the listbox keeps DOM focus and points at the
      // active row through `aria-activedescendant`, so the row needs a real id.
      id={props.domId}
      data-source-control-row={row.key}
      aria-selected={props.selected}
      aria-busy={props.busy}
      role="option"
    >
      <div
        style={{ height: CHANGES_ROW_HEIGHT.file, paddingLeft: props.indentPx }}
        className={cn(
          "group relative flex cursor-default items-center gap-2 pr-3 text-sm",
          props.selected ? "bg-accent" : "hover:bg-accent/50",
          // One focus vocabulary with the rest of the app (m5): the listbox owns
          // the tab stop, so the focused ROW is marked with an inset ring rather
          // than an offset one that would clip against its neighbours.
          props.focused && "inset-ring-1 inset-ring-ring",
          props.busy && "opacity-64",
        )}
        onClick={(event) => props.onSelect(row, event)}
        onDoubleClick={() => props.onOpen(row)}
      >
        {!props.showDirectory ? (
          <>
            <span className="size-3 shrink-0" aria-hidden />
            <FileIcon className="size-3.5 shrink-0 text-muted-foreground/55" aria-hidden />
          </>
        ) : null}
        <PathLabel name={name} dir={props.showDirectory ? dir : ""} />

        {props.partial ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="shrink-0 text-[10px] font-medium text-warning-foreground">
                  partial
                </span>
              }
            />
            <TooltipPopup>Some changes to this file are staged and some are not.</TooltipPopup>
          </Tooltip>
        ) : null}

        {hasStat ? (
          <span
            className={cn(
              "shrink-0 text-xs transition-opacity",
              "group-hover:opacity-0 pointer-coarse:opacity-0",
              (props.focused || props.busy) && "opacity-0",
            )}
          >
            <DiffStatLabel
              additions={file.insertions ?? 0}
              deletions={file.deletions ?? 0}
              className="gap-1"
            />
          </span>
        ) : null}

        <span
          className={cn(
            "absolute right-7 top-1/2 flex -translate-y-1/2 items-center justify-end gap-0 rounded-sm bg-background opacity-0 transition-opacity group-hover:bg-accent",
            "group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100",
            props.selected && "bg-accent",
            (props.focused || props.busy) && "opacity-100",
          )}
        >
          {staged ? (
            <RowAction label="Unstage" busy={props.busy} onClick={() => props.onUnstage(row)}>
              <Minus />
            </RowAction>
          ) : (
            <RowAction label="Stage" busy={props.busy} onClick={() => props.onStage(row)}>
              <Plus />
            </RowAction>
          )}
          {!staged && !conflicted ? (
            <RowAction label="Discard" busy={props.busy} onClick={() => props.onDiscard(row)}>
              <Undo2 />
            </RowAction>
          ) : null}
        </span>

        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className={cn(
                  "w-3 shrink-0 text-center font-mono text-xs font-medium",
                  LETTER_TONE[letter] ?? "text-muted-foreground",
                )}
              >
                {letter}
              </span>
            }
          />
          <TooltipPopup>{changeLabel(file.change)}</TooltipPopup>
        </Tooltip>
      </div>
      {conflicted ? (
        <div
          style={{ height: CONFLICT_ACTIONS_HEIGHT, paddingLeft: props.indentPx }}
          className="flex items-center gap-1 pr-3"
        >
          {/* fork: f4 F-06 — conflict rungs disable while this path resolves. */}
          <ConflictAction busy={props.busy} onClick={() => props.onResolve(row, "ours")}>
            Accept current
          </ConflictAction>
          <ConflictAction busy={props.busy} onClick={() => props.onResolve(row, "theirs")}>
            Accept incoming
          </ConflictAction>
          <ConflictAction busy={props.busy} onClick={() => props.onResolve(row)}>
            Mark resolved
          </ConflictAction>
        </div>
      ) : null}
    </div>
  );
}

function RowAction(props: {
  label: string;
  busy: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={props.label}
            // fork: f4 focus model — the listbox is the single tab stop for the
            // whole list; 20 rendered rows × 2 buttons would otherwise put 40
            // stops between the filter box and the composer. The keyboard path
            // to these actions is `s` / `u` / `x` on the focused row.
            tabIndex={-1}
            // fork: f4 F-06 — while this path's action is in flight the button
            // is disabled and spinning, instead of staying live and silently
            // discarding the second press.
            disabled={props.busy}
            onClick={(event) => {
              event.stopPropagation();
              props.onClick();
            }}
          >
            {props.busy ? <Loader2 className="animate-spin" /> : props.children}
          </Button>
        }
      />
      <TooltipPopup>{props.busy ? `${props.label} — working…` : props.label}</TooltipPopup>
    </Tooltip>
  );
}

function ConflictAction(props: { busy: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button
      size="xs"
      variant="outline"
      tabIndex={-1}
      disabled={props.busy}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
    >
      {props.children}
    </Button>
  );
}

export const ChangeRow = memo(ChangeRowImpl);
