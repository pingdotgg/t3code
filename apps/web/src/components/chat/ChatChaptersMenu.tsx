import { BookmarkIcon, XIcon } from "lucide-react";
import { memo, useState } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useChatChapterStore, useThreadChapters } from "~/chatChapterStore";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

/** Pinned messages in conversation order. Choosing one scrolls the timeline to it. */
export const ChatChaptersMenu = memo(function ChatChaptersMenu({
  threadRef,
}: {
  threadRef: ScopedThreadRef;
}) {
  const chapters = useThreadChapters(threadRef);
  const requestReveal = useChatChapterStore((state) => state.requestReveal);
  const unpin = useChatChapterStore((state) => state.unpin);
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            aria-label={chapters.length > 0 ? `Chapters, ${chapters.length}` : "Chapters"}
            type="button"
            size="xs"
            variant="ghost-muted"
          />
        }
      >
        <BookmarkIcon className={cn("size-3", chapters.length > 0 && "fill-current")} />
        {chapters.length > 0 ? (
          <span className="ms-1 text-xs tabular-nums">{chapters.length}</span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="md" padding="compact">
        <div className="px-2 pb-1">
          <PopoverTitle>Chapters</PopoverTitle>
        </div>
        {chapters.length === 0 ? (
          <p className="px-2 pb-2 text-xs text-muted-foreground">
            Pin a message to make it a chapter. Pinned messages are listed here in order.
          </p>
        ) : (
          <ol aria-label="Chapters" className="flex max-h-96 flex-col gap-0.5 overflow-y-auto">
            {chapters.map((chapter) => (
              <li key={chapter.messageId} className="flex items-start gap-1">
                <div className="min-w-0 flex-1">
                  <Button
                    type="button"
                    size="sm-multiline"
                    variant="ghost"
                    onClick={() => {
                      requestReveal(threadRef, chapter.messageId);
                      setOpen(false);
                    }}
                    className="w-full justify-start text-left"
                  >
                    <span className="min-w-0 break-words">{chapter.title}</span>
                  </Button>
                </div>
                <Button
                  aria-label={`Remove chapter ${chapter.title}`}
                  type="button"
                  size="icon-xs"
                  variant="ghost-muted"
                  className="mt-1"
                  onClick={() => unpin(threadRef, chapter.messageId)}
                >
                  <XIcon className="size-3" />
                </Button>
              </li>
            ))}
          </ol>
        )}
      </PopoverPopup>
    </Popover>
  );
});
