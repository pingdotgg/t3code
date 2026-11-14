import type { ScopedThreadRef } from "@t3tools/contracts";
import { PinIcon, PinOffIcon } from "lucide-react";
import { use } from "react";

import { useThreadEntryPins } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TimelineRowCtx } from "./timelineRowContext";

export function useSetEntryPin(threadRef: ScopedThreadRef | null) {
  const setEntryPin = useOrchestrationCommand(threadEnvironment.setEntryPin, {
    reportFailure: false,
  });
  return async (entryId: string, pinned: boolean) => {
    if (threadRef === null) return;
    const result = await setEntryPin({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, entryId, pinned },
    });
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: pinned ? "Could not pin" : "Could not unpin" });
    }
  };
}

/** Pin state and toggle for one timeline entry, or null when this viewer cannot pin here. */
export function useTimelineEntryPin(entryId: string) {
  const ctx = use(TimelineRowCtx);
  const pinned = useThreadEntryPins(ctx.threadRef).some((pin) => pin.entryId === entryId);
  const setEntryPin = useSetEntryPin(ctx.threadRef);
  if (ctx.threadRef === null || !ctx.canOperateThread) return null;
  return { pinned, toggle: () => void setEntryPin(entryId, !pinned) };
}

export function EntryPinButton(props: {
  readonly entryId: string;
  readonly variant?: "ghost-muted" | "glass";
}) {
  const pin = useTimelineEntryPin(props.entryId);
  if (pin === null) return null;
  const label = pin.pinned ? "Unpin" : "Pin";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size={props.variant === "glass" ? "icon-xs" : "xs"}
            variant={props.variant ?? "ghost-muted"}
            aria-label={label}
            aria-pressed={pin.pinned}
            onClick={pin.toggle}
          />
        }
      >
        {pin.pinned ? (
          <PinOffIcon className={props.variant === "glass" ? "size-3.5" : "size-3"} aria-hidden />
        ) : (
          <PinIcon className={props.variant === "glass" ? "size-3.5" : "size-3"} aria-hidden />
        )}
      </TooltipTrigger>
      <TooltipPopup side={props.variant === "glass" ? "left" : "top"}>{label}</TooltipPopup>
    </Tooltip>
  );
}
