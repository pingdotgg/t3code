import { useState } from "react";
import { formatModelSlugName } from "@t3tools/shared/model";
import {
  decideDaybreakModelChange,
  getDaybreakModelChangeChoices,
} from "@t3tools/client-runtime/model-traits";
import type {
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";

type PendingChange = {
  currentOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  target: ModelSelection;
  commit: (selection: ModelSelection) => void;
  clearsDaybreak?: boolean;
  destinationContext?: string | undefined;
  contextKey: string;
};

export function useDaybreakModelChange(
  getDescriptors: (
    selection: ModelSelection,
    destinationContext?: string,
  ) => ReadonlyArray<ProviderOptionDescriptor> | null,
  contextKey: string,
) {
  const [pendingChange, setPending] = useState<PendingChange | null>(null);
  const pending = pendingChange?.contextKey === contextKey ? pendingChange : null;
  if (pendingChange && pendingChange.contextKey !== contextKey) setPending(null);
  const decide = (change: PendingChange) => {
    const descriptors = change.clearsDaybreak
      ? []
      : getDescriptors(change.target, change.destinationContext);
    return descriptors === null
      ? null
      : decideDaybreakModelChange(change.currentOptions, change.target, descriptors);
  };
  const requestModelChange = (
    currentOptions: PendingChange["currentOptions"],
    target: ModelSelection,
    commit: PendingChange["commit"],
    clearsDaybreak = false,
    destinationContext?: string,
  ) => {
    const change = {
      currentOptions,
      target,
      commit,
      clearsDaybreak,
      contextKey,
      destinationContext,
    };
    const decision = decide(change);
    if (!decision) return;
    if (decision.type === "ready") commit(decision.selection);
    else setPending(change);
  };
  const decision = pending ? decide(pending) : null;
  const choose = (selection: ModelSelection) => {
    if (!pending) return;
    // A catalog refresh can revoke an offered program while the dialog is open.
    const latest = decide({ ...pending, currentOptions: selection.options, target: selection });
    if (!latest || latest.type !== "ready") {
      setPending({ ...pending });
      return;
    }
    setPending(null);
    pending.commit(latest.selection);
  };
  const choices =
    pending && decision
      ? getDaybreakModelChangeChoices(
          pending.target,
          pending.clearsDaybreak
            ? []
            : (getDescriptors(pending.target, pending.destinationContext) ?? []),
        )
      : [];
  const daybreakDialog = (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {decision?.type === "confirm" && !pending?.clearsDaybreak
              ? `${decision.activeLabel} isn’t available on ${formatModelSlugName(pending?.target.model ?? "this model")}`
              : "Change Daybreak program?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {decision?.type === "confirm"
              ? pending?.clearsDaybreak
                ? `Resetting the default model clears its saved ${decision.activeLabel} selection.`
                : "Choose an available option to switch models, or cancel to keep your current selection."
              : decision
                ? "Daybreak availability has changed. Confirm the model change to continue."
                : "This model or account is no longer available. Cancel and choose another model."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => setPending(null)}>
            Cancel
          </Button>
          {choices.map((choice) => (
            <Button variant="outline" key={choice.label} onClick={() => choose(choice.selection)}>
              {pending?.clearsDaybreak ? "Reset default" : choice.label}
            </Button>
          ))}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
  return { requestModelChange, daybreakDialog };
}
