import type { ThreadContextRecord } from "@t3tools/contracts";
import { memo } from "react";

import { cn } from "~/lib/utils";

export const ThreadContextChip = memo(function ThreadContextChip(props: {
  record: ThreadContextRecord;
  liveTitle: string | null;
  disabled?: boolean | undefined;
  onRemove: (contextId: ThreadContextRecord["contextId"]) => void;
}) {
  const title = props.liveTitle?.trim().length
    ? props.liveTitle.trim()
    : props.record.title?.trim().length
      ? props.record.title
      : props.record.label;
  return (
    <span
      className={cn(
        "group inline-flex max-w-60 items-center gap-1.5 rounded-md border border-border/70 bg-muted/60 py-0.5 pr-1 pl-1.5 text-xs text-foreground",
      )}
      data-thread-context-chip={String(props.record.contextId)}
      title={title}
    >
      <span aria-hidden="true" className="text-muted-foreground">
        #
      </span>
      <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
      <button
        type="button"
        aria-label={`Remove ${title}`}
        disabled={props.disabled}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onRemove(props.record.contextId);
        }}
        className="inline-flex size-4 items-center justify-center rounded text-muted-foreground opacity-60 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      >
        ×
      </button>
    </span>
  );
});
