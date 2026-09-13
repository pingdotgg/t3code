/**
 * The menu behind a "change this" glyph on an issue or a pull request: a search over what the host
 * gave, and a list where a row is either already chosen or not. Labels, assignees and reviewers all
 * ask a different question of a different host route, so each caller keeps its own reading, its own
 * narrowing and its own rows; only the frame around them is written here.
 *
 * Nothing is asked of the host by this frame — it is the caller that reads when `open` turns true —
 * so what stands in while that read is in flight, and what is said when it fails or finds nothing,
 * arrive from the caller as well.
 */
import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function EntityPicker({
  icon,
  label,
  allowed,
  disallowedReason,
  open,
  onOpenChange,
  searchLabel,
  query,
  onQueryChange,
  loading,
  message,
  note,
  children,
}: {
  /** The caller's own glyph, at the weight of the icons beside it. */
  icon: ReactNode;
  /** What the glyph does, spoken — it carries no text of its own. */
  label: string;
  /** False where the host would refuse this account, which is worth saying rather than hiding:
   * the control disabled with a reason answers the question its absence would raise. */
  allowed: boolean;
  disallowedReason: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names the search box and stands in it, so it says what is being searched. */
  searchLabel: string;
  query: string;
  onQueryChange: (query: string) => void;
  /** What stands in for the rows while the host is being read. */
  loading?: ReactNode;
  /** Said in place of the rows: a failure, or nothing to choose from. */
  message: string | null;
  /** Said under the rows when the host gave only part of what it has. */
  note: string | null;
  children: ReactNode;
}) {
  if (!allowed) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button size="icon-xs" variant="ghost" disabled aria-label={label}>
              {icon}
            </Button>
          }
        />
        <TooltipPopup side="bottom">{disallowedReason}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger
        render={
          <Button size="icon-xs" variant="ghost" aria-label={label}>
            {icon}
          </Button>
        }
      />
      <MenuPopup align="start" side="bottom" className="w-72 p-0">
        <div className="border-b border-border/60 p-2">
          <Input
            autoFocus
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder={searchLabel}
            aria-label={searchLabel}
            size="compact"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {loading ??
            (message !== null ? (
              <p className="p-2 text-xs text-muted-foreground">{message}</p>
            ) : (
              children
            ))}
          {note !== null ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{note}</p>
          ) : null}
        </div>
      </MenuPopup>
    </Menu>
  );
}

/** One row of the list: what it stands for, and whether it is already chosen. */
export function EntityPickerOption({
  checked,
  checkedLabel,
  disabled,
  onSelect,
  children,
}: {
  checked: boolean;
  /** What being checked means here, spoken — the tick alone does not say it. */
  checkedLabel: string;
  disabled: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/60 disabled:opacity-60"
    >
      {children}
      {checked ? <CheckIcon aria-label={checkedLabel} className="size-3.5 shrink-0" /> : null}
    </button>
  );
}
