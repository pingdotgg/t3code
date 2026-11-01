import { ListOrderedIcon } from "lucide-react";
import { useState } from "react";

import type { TimelineMinimapItem } from "./timelineMinimapItems";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export function PromptIndex({
  items,
  onSelect,
}: {
  readonly items: ReadonlyArray<TimelineMinimapItem>;
  readonly onSelect: (item: TimelineMinimapItem) => void;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;

  return (
    <div className="absolute top-2 right-3 z-40">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={<Button aria-label="Browse prompts in this thread" size="sm" variant="outline" />}
        >
          <ListOrderedIcon aria-hidden className="size-4" />
          Prompts
        </PopoverTrigger>
        <PopoverPopup
          align="end"
          aria-label="Prompts in this thread"
          className="max-h-[min(70vh,36rem)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto"
          side="bottom"
        >
          <div className="p-1">
            <ol className="flex flex-col gap-0.5">
              {items.map((item, index) => {
                const preview = item.userText?.replace(/\s+/gu, " ").trim();
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="flex w-full cursor-pointer items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() => {
                        setOpen(false);
                        onSelect(item);
                      }}
                    >
                      <span className="mt-0.5 shrink-0 text-xs tabular-nums text-muted-foreground">
                        {index + 1}.
                      </span>
                      <span className="line-clamp-3 min-w-0 break-words">
                        {preview || "Attachment or empty prompt"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
