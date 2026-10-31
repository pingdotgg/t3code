import { History, X } from "lucide-react";

import { isValidHistoryTimestamp, type BrowserHistoryEntry } from "~/browserHistoryStore";
import { RelativeTime } from "~/components/RelativeTime";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

interface Props {
  entry: BrowserHistoryEntry;
  onOpen: () => void;
  onRemove: () => void;
}

/** A plain history row: page title, then its address; the visit time is in the tooltip. */
export function PreviewRecentUrlCard({ entry, onOpen, onRemove }: Props) {
  const parsed = new URL(entry.url);
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  const label = `${parsed.host}${path}${parsed.search}${parsed.hash}`;
  const visitedAt = isValidHistoryTimestamp(entry.lastVisitedAt) ? (
    <RelativeTime timestamp={new Date(entry.lastVisitedAt).toISOString()} />
  ) : null;
  return (
    <div className="group relative flex w-full items-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={onOpen}
              className="flex h-8 w-full min-w-0 items-center gap-2.5 rounded-control px-2.5 pr-9 text-left hover:surface-ghost-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <History aria-hidden className="size-3.25 shrink-0 text-dim-foreground" />
          {entry.title ? (
            <span className="min-w-0 shrink truncate text-sm text-foreground">{entry.title}</span>
          ) : null}
          <span
            className={
              entry.title
                ? "min-w-0 flex-1 truncate text-caption text-dim-foreground"
                : "min-w-0 flex-1 truncate text-body text-foreground"
            }
          >
            {label}
          </span>
        </TooltipTrigger>
        <TooltipPopup>
          {visitedAt ? (
            <>
              {entry.url} · {visitedAt}
            </>
          ) : (
            entry.url
          )}
        </TooltipPopup>
      </Tooltip>
      <button
        type="button"
        aria-label={`Remove ${label} from history`}
        onClick={onRemove}
        className="absolute right-2 rounded-kbd p-1 text-muted-foreground opacity-0 hover:surface-ghost-hover hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-hover:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
