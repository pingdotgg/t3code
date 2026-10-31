import { memo } from "react";
import { PinIcon } from "lucide-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { type ChapterMessage, useChatChapterStore, useIsChapterPinned } from "~/chatChapterStore";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

export const ChatChapterPinButton = memo(function ChatChapterPinButton({
  threadRef,
  message,
}: {
  threadRef: ScopedThreadRef;
  message: ChapterMessage;
}) {
  const pinned = useIsChapterPinned(threadRef, message.id);
  const togglePin = useChatChapterStore((state) => state.togglePin);
  const label = pinned ? "Unpin chapter" : "Pin as chapter";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-pressed={pinned}
            onClick={() => togglePin(threadRef, message)}
            type="button"
            size="xs"
            variant="ghost-muted"
          />
        }
      >
        <PinIcon className={cn("size-3", pinned && "fill-current text-primary")} />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
});
