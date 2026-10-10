import { MoreHorizontalIcon } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { UseInPopover, type PlaceOptions } from "./SkillUseIn";
import {
  planDelete,
  planTurnOffAll,
  planTurnOnAll,
  type Skill,
  type SkillPlan,
  type SkillsContext,
} from "./SkillsSettings.logic";

/**
 * Acts on every ticked row. It sticks to the bottom of the page, so it is in reach on a phone,
 * where Turn on, Turn off and Delete fold into one menu.
 */
export function BulkBar({
  selected,
  ctx,
  places,
  busy,
  onPlan,
}: {
  selected: readonly Skill[];
  ctx: SkillsContext;
  places: PlaceOptions;
  /** A change is being made, so nothing else can start. */
  busy: boolean;
  onPlan: (plan: SkillPlan) => void;
}) {
  const turnOn = planTurnOnAll(selected, ctx);
  const turnOff = planTurnOffAll(selected, ctx, { ask: selected.length > 1 });
  const del = planDelete(selected, ctx);
  return (
    <div
      role="region"
      aria-label="Actions for selected skills"
      className="sticky bottom-0 z-20 rounded-xl border border-border/60 bg-background px-3 py-2 shadow-xs/5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-sm font-medium">{selected.length} selected</span>
        <UseInPopover skills={selected} places={places} busy={busy} side="top" onPlan={onPlan} />
        <span className="hidden items-center gap-2 sm:flex">
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !turnOn}
            title={turnOn ? undefined : "Already on for every agent"}
            onClick={() => turnOn && onPlan(turnOn)}
          >
            Turn on
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !turnOff}
            title={turnOff ? undefined : "Already off for every agent"}
            onClick={() => turnOff && onPlan(turnOff)}
          >
            Turn off
          </Button>
          {del && (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              title="Deletes the skills' folders. This can't be undone."
              onClick={() => onPlan(del)}
            >
              Delete…
            </Button>
          )}
        </span>
        <span className="sm:hidden">
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="outline"
                  aria-label="More actions"
                  disabled={busy}
                />
              }
            >
              <MoreHorizontalIcon />
            </MenuTrigger>
            <MenuPopup align="end" side="top">
              <MenuItem disabled={!turnOn} onClick={() => turnOn && onPlan(turnOn)}>
                Turn on
              </MenuItem>
              <MenuItem disabled={!turnOff} onClick={() => turnOff && onPlan(turnOff)}>
                Turn off
              </MenuItem>
              {del && <MenuSeparator />}
              {del && (
                <MenuItem variant="destructive" onClick={() => onPlan(del)}>
                  Delete…
                </MenuItem>
              )}
            </MenuPopup>
          </Menu>
        </span>
      </div>
    </div>
  );
}

/** Asks before a plan changes anything, with the same plain words for one skill or many. */
export function ConfirmPlan({
  plan,
  onCancel,
  onConfirm,
}: {
  /** The plan to confirm; a plan without a confirmation never opens the dialog. */
  plan: SkillPlan | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Keep the last text while the dialog closes, so it doesn't blank out first.
  const [shown, setShown] = useState(plan?.confirmation);
  if (plan?.confirmation && plan.confirmation !== shown) setShown(plan.confirmation);
  return (
    <AlertDialog
      open={plan?.confirmation !== undefined}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{shown?.title}</AlertDialogTitle>
          {shown?.body && <AlertDialogDescription>{shown.body}</AlertDialogDescription>}
        </AlertDialogHeader>
        {shown && shown.notes.length > 0 && (
          <ul className="space-y-1 px-6 pb-4 text-xs break-words text-muted-foreground">
            {shown.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
        <AlertDialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={shown?.destructive ? "destructive" : "default"} onClick={onConfirm}>
            {shown?.confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
