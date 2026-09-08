import { ChevronDownIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import {
  summarizeProjectSettingSources,
  type ProjectSettingSourceEntry,
} from "./ProjectSettingSource.logic";

export type { ProjectSettingSourceEntry } from "./ProjectSettingSource.logic";

export function ProjectSettingSource({
  entries,
  className,
}: {
  entries: readonly ProjectSettingSourceEntry[];
  className?: string;
}) {
  if (entries.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "inline-flex items-center gap-1 rounded text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
          className,
        )}
        aria-label="Inspect setting sources"
      >
        {summarizeProjectSettingSources(entries)}
        <ChevronDownIcon className="size-3" />
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <PopoverTitle className="text-sm">Setting sources</PopoverTitle>
        <ul className="mt-3 divide-y divide-border">
          {entries.map((entry) => (
            <li key={entry.key} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
              <span className="break-all text-sm font-medium">{entry.label}</span>
              <span className="text-sm">{entry.value}</span>
              <span className="text-xs text-muted-foreground">{entry.source}</span>
              {entry.defaultValue !== undefined ? (
                <span className="text-xs text-muted-foreground">
                  Environment default: {entry.defaultValue}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </PopoverPopup>
    </Popover>
  );
}
