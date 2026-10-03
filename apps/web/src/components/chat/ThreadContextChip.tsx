import type { ThreadContextRecord } from "@t3tools/contracts";
import { memo } from "react";
import { MessagesSquareIcon, XIcon } from "lucide-react";
import { useStore } from "~/store";

import { cn } from "~/lib/utils";

export const ThreadContextChip = memo(function ThreadContextChip(props: {
  record: ThreadContextRecord;
  liveTitle?: string | null | undefined;
  disabled?: boolean | undefined;
  onRemove?: ((contextId: ThreadContextRecord["contextId"]) => void) | undefined;
}) {
  const liveTitle = useStore(
    (state) =>
      state.environmentStateById[props.record.environmentId]?.threadShellById[props.record.threadId]
        ?.title ?? null,
  );
  const currentTitle = props.liveTitle ?? liveTitle;
  const title = currentTitle?.trim().length
    ? currentTitle.trim()
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
      <MessagesSquareIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
      <a
        href={`/${encodeURIComponent(props.record.environmentId)}/${encodeURIComponent(props.record.threadId)}`}
        className="min-w-0 flex-1 truncate font-medium no-underline"
        aria-label={`Open thread ${title}`}
      >
        {title}
      </a>
      {props.onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${title}`}
          disabled={props.disabled}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            props.onRemove?.(props.record.contextId);
          }}
          className="inline-flex size-4 items-center justify-center rounded text-muted-foreground opacity-60 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          <XIcon aria-hidden="true" className="size-3" />
        </button>
      ) : null}
    </span>
  );
});
