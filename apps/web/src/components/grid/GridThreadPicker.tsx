import { type EnvironmentId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { LayersIcon, SearchIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../../store";
import type { SidebarThreadSummary } from "../../types";

interface GridThreadPickerProps {
  environmentId: EnvironmentId;
  excludedThreadKeys: ReadonlySet<string>;
  onSelect: (threadKey: string) => void;
  triggerClassName?: string;
  triggerLabel?: string;
}

export function GridThreadPicker({
  environmentId,
  excludedThreadKeys,
  onSelect,
  triggerClassName,
  triggerLabel,
}: GridThreadPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const threads = useStore(
    useShallow((store) =>
      selectSidebarThreadsAcrossEnvironments(store).filter(
        (thread) => thread.environmentId === environmentId && thread.archivedAt === null,
      ),
    ),
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const available = threads.filter((thread) => {
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      return !excludedThreadKeys.has(key);
    });
    if (q.length === 0) return available;
    return available.filter((thread) => thread.title.toLowerCase().includes(q));
  }, [threads, query, excludedThreadKeys]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="xs"
            className={cn("gap-1.5", triggerClassName)}
            aria-label="Pick a thread to assign to this cell"
          >
            <LayersIcon className="size-3" />
            {triggerLabel ?? "Pick thread"}
          </Button>
        }
      />
      <PopoverPopup align="start" sideOffset={4} className="w-80">
        <div className="flex flex-col gap-2" data-grid-thread-picker-root>
          <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1">
            <SearchIcon className="size-3.5 shrink-0 opacity-50" />
            <input
              type="text"
              value={query}
              placeholder="Search threads..."
              onChange={(event) => setQuery(event.target.value)}
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                No threads available.
              </div>
            ) : (
              filtered.map((thread) => (
                <PickerItem
                  key={thread.id}
                  thread={thread}
                  onSelect={() => {
                    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
                    onSelect(key);
                    setOpen(false);
                    setQuery("");
                  }}
                />
              ))
            )}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function PickerItem({ thread, onSelect }: { thread: SidebarThreadSummary; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent focus:bg-accent focus:outline-none"
    >
      <span className="line-clamp-1 font-medium">{thread.title || "Untitled thread"}</span>
      {thread.latestUserMessageAt ? (
        <span className="text-[10px] text-muted-foreground">
          Last activity: {new Date(thread.latestUserMessageAt).toLocaleString()}
        </span>
      ) : null}
    </button>
  );
}
