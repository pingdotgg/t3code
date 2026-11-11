import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { PinIcon, PinOffIcon } from "lucide-react";
import { use } from "react";

import { useThreadMessagePins } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TimelineRowCtx } from "./timelineRowContext";

export function useSetMessagePin(threadRef: ScopedThreadRef | null) {
  const setMessagePin = useOrchestrationCommand(threadEnvironment.setMessagePin, {
    reportFailure: false,
  });
  return async (messageId: MessageId, pinned: boolean) => {
    if (threadRef === null) return;
    const result = await setMessagePin({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, messageId, pinned },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: pinned ? "Could not pin message" : "Could not unpin message",
      });
    }
  };
}

export function MessagePinButton({ messageId }: { messageId: MessageId }) {
  const ctx = use(TimelineRowCtx);
  const pinned = useThreadMessagePins(ctx.threadRef).some((pin) => pin.messageId === messageId);
  const setMessagePin = useSetMessagePin(ctx.threadRef);
  if (ctx.threadRef === null || !ctx.canOperateThread) return null;
  const label = pinned ? "Unpin message" : "Pin message";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label={label}
            aria-pressed={pinned}
            onClick={() => void setMessagePin(messageId, !pinned)}
          />
        }
      >
        {pinned ? (
          <PinOffIcon className="size-3" aria-hidden />
        ) : (
          <PinIcon className="size-3" aria-hidden />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
