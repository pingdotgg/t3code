import { useSyncExternalStore } from "react";

import { firstUseHints, type FirstUseHintAction } from "../firstUseHints";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

export function FirstUseHintHost() {
  const { current } = useSyncExternalStore(
    firstUseHints.subscribe,
    firstUseHints.getSnapshot,
    firstUseHints.getSnapshot,
  );

  if (current === null) return null;

  const dismiss = () => {
    if (firstUseHints.dismiss(current.id)) current.onDismiss?.();
  };
  const select = (action: FirstUseHintAction) => {
    try {
      action.onSelect();
    } finally {
      dismiss();
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{current.title}</DialogTitle>
          <DialogDescription>{current.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter variant="bare">
          {current.secondaryAction ? (
            <Button variant="outline" onClick={() => select(current.secondaryAction!)}>
              {current.secondaryAction.label}
            </Button>
          ) : null}
          <Button
            onClick={() => {
              if (current.primaryAction) select(current.primaryAction);
              else dismiss();
            }}
          >
            {current.primaryAction?.label ?? "Got it"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
