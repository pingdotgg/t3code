import { MessageSquareIcon, PlusIcon, XIcon } from "lucide-react";
import { memo } from "react";

import type { ThreadContentTab } from "../../threadTabs";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ThreadTabStripProps {
  readonly tabs: ReadonlyArray<ThreadContentTab>;
  readonly canCreateChatTab: boolean;
  readonly creatingChatTab: boolean;
  readonly onSelectTab: (tab: ThreadContentTab) => void;
  readonly onCloseTab: (tab: ThreadContentTab) => void;
  readonly onCreateChatTab: () => void;
}

export const ThreadTabStrip = memo(function ThreadTabStrip({
  tabs,
  canCreateChatTab,
  creatingChatTab,
  onSelectTab,
  onCloseTab,
  onCreateChatTab,
}: ThreadTabStripProps) {
  if (tabs.length <= 1 && !canCreateChatTab) {
    return null;
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <div
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain"
        role="tablist"
        aria-label="Thread tabs"
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              "group/tab flex h-7 min-w-0 max-w-52 shrink-0 items-center rounded-md border text-xs transition-colors focus-within:ring-1 focus-within:ring-ring",
              tab.active
                ? "border-border bg-card text-foreground"
                : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
            onMouseDown={(event) => {
              if (event.button !== 1) {
                return;
              }
              event.preventDefault();
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              onCloseTab(tab);
            }}
          >
            <span className="relative ml-1.5 flex size-3.5 shrink-0 items-center justify-center">
              <MessageSquareIcon
                className={cn(
                  "size-3.5 transition-opacity",
                  tab.active
                    ? "opacity-0"
                    : "opacity-100 group-hover/tab:opacity-0 group-focus-within/tab:opacity-0",
                )}
              />
              <button
                type="button"
                className={cn(
                  "pointer-events-none absolute left-1/2 top-1/2 flex size-5 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm opacity-0 outline-hidden transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
                  tab.active
                    ? "pointer-events-auto opacity-100"
                    : "group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 group-focus-within/tab:pointer-events-auto group-focus-within/tab:opacity-100",
                )}
                aria-label={`Close ${tab.title}`}
                tabIndex={tab.active ? 0 : -1}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onCloseTab(tab);
                }}
              >
                <XIcon className="size-3" />
              </button>
            </span>
            <button
              type="button"
              role="tab"
              aria-selected={tab.active}
              className="flex h-full min-w-0 flex-1 cursor-pointer items-center px-1.5 pr-2 text-left outline-hidden"
              onClick={() => onSelectTab(tab)}
            >
              <span className="min-w-0 truncate">{tab.title}</span>
            </button>
          </div>
        ))}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="New chat tab"
              disabled={!canCreateChatTab || creatingChatTab}
              onClick={onCreateChatTab}
            />
          }
        >
          <PlusIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {canCreateChatTab ? "New chat tab" : "Start this draft before adding tabs"}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});
