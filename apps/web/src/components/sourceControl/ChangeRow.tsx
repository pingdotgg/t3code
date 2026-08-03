/**
 * One file row in the changes list.
 *
 * The row's pitch is NOT decided here: it is `CHANGES_ROW_HEIGHT.file` (plus
 * the conflict bar when present), applied as an explicit height so the rendered
 * pitch and the pitch the virtualizer assumed cannot drift. A wrong pitch
 * drifts the window silently, which is the worst kind of layout bug.
 *
 * fork: f4 redesign (audit §8) — three structural changes here:
 *
 *  1. ONE gutter. The left inset is `changesRowIndent(depth)`, the same
 *     12 + 12·depth every other row, header and band in the panel uses.
 *  2. A RESERVED action slot. The actions used to be `hidden group-hover:flex`
 *     and the diffstat `group-hover:hidden`, so two different-width blocks
 *     traded places under the pointer on every row you crossed. Now both are
 *     always laid out and the actions only change opacity — visible on hover,
 *     on focus, on the selected row, and always on a coarse pointer.
 *  3. House primitives. `Button size="icon-xs"` brings the focus ring, the 44px
 *     `pointer-coarse` target and `disabled:opacity-64`; `DiffStatLabel` brings
 *     the fixed `4ch_4ch` grid that stops the right edge from jittering.
 *
 * fork: f4 source-control panel
 */
import { Loader2, Minus, Plus, Undo2 } from "lucide-react";
import { memo } from "react";

import { CHANGES_ROW_HEIGHT, CONFLICT_ACTIONS_HEIGHT } from "~/lib/sourceControl/changesRows";
import type { ChangesRow } from "~/lib/sourceControl/changesRows";
import { Badge } from "~/components/ui/badge";
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

/**
 * The trailing slot is laid out whether or not its buttons are visible, so
 * nothing in the row moves when the pointer arrives. Two rungs on an unstaged
 * row, one on a staged one.
 */
const ACTION_SLOT_WIDTH = { one: 24, two: 48 } as const;

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
          "group flex cursor-default items-center gap-2 pr-3 text-sm",
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

        <PathLabel name={name} dir={dir} />

        {props.partial ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge size="sm" variant="secondary" className="shrink-0">
                  partial
                </Badge>
              }
            />
            <TooltipPopup>Some changes to this file are staged and some are not.</TooltipPopup>
          </Tooltip>
        ) : null}

        {hasStat ? (
          <span className="shrink-0 text-xs">
            <DiffStatLabel
              additions={file.insertions ?? 0}
              deletions={file.deletions ?? 0}
              className="gap-1"
            />
          </span>
        ) : null}

        <span
          style={{ width: staged || conflicted ? ACTION_SLOT_WIDTH.one : ACTION_SLOT_WIDTH.two }}
          className={cn(
            "flex shrink-0 items-center justify-end gap-0 opacity-0 transition-opacity",
            "group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100",
            props.selected && "opacity-100",
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
