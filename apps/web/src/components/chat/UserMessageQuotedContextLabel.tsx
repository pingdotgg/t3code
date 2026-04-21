import { ChevronDownIcon, CornerDownRightIcon } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "~/lib/utils";
import type { ParsedQuotedContextEntry } from "../../lib/quotedContext";

type EntryKind = "text" | "code" | "diff";

function classifyEntry(entry: ParsedQuotedContextEntry): EntryKind {
  if (entry.header.startsWith("Quoted diff")) return "diff";
  if (entry.header.startsWith("Quoted code")) return "code";
  return "text";
}

export function UserMessageQuotedContextLabel({
  contexts,
}: {
  contexts: ReadonlyArray<ParsedQuotedContextEntry>;
}) {
  const baseId = useId();
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());

  if (contexts.length === 0) return null;

  const toggle = (idx: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  return (
    <div className="mb-1.5 space-y-1.5">
      {contexts.map((ctx, idx) => {
        const kind = classifyEntry(ctx);
        const isDiff = kind === "diff";
        const isMonospace = kind !== "text";
        const isExpanded = expanded.has(idx);
        const panelId = `${baseId}-quote-${idx}`;

        return (
          <div
            key={ctx.header + String(idx)}
            className={cn(
              "rounded-md rounded-l-none border-l-2 transition-colors",
              isDiff
                ? "border-emerald-400/70 bg-emerald-500/8 hover:bg-emerald-500/12 dark:border-emerald-400/70 dark:bg-emerald-400/8 dark:hover:bg-emerald-400/12"
                : "border-violet-400/70 bg-violet-500/8 hover:bg-violet-500/12 dark:border-violet-400/70 dark:bg-violet-400/8 dark:hover:bg-violet-400/12",
            )}
          >
            <button
              type="button"
              onClick={() => toggle(idx)}
              aria-expanded={isExpanded}
              aria-controls={panelId}
              className={cn(
                "flex w-full cursor-pointer items-center gap-1.5 rounded-md rounded-l-none px-2.5 py-1.5 text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                isDiff
                  ? "text-emerald-700 dark:text-emerald-300"
                  : "text-violet-700 dark:text-violet-300",
              )}
            >
              <CornerDownRightIcon className="size-3 shrink-0 opacity-80" />
              <span className="truncate">{ctx.header}</span>
              <ChevronDownIcon
                className={cn(
                  "ml-auto size-3 shrink-0 opacity-70 transition-transform",
                  isExpanded && "rotate-180",
                )}
              />
            </button>
            {ctx.body && (
              <div
                id={panelId}
                role="region"
                aria-label={`Quoted content: ${ctx.header}`}
                className="px-2.5 pb-1.5"
              >
                <div
                  className={cn(
                    "whitespace-pre-wrap break-words text-xs text-muted-foreground",
                    isMonospace && "font-mono",
                    !isExpanded && (isMonospace ? "line-clamp-3" : "line-clamp-2"),
                  )}
                >
                  {ctx.body}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
