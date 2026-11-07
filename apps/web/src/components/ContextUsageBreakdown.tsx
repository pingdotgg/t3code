import type { ProviderContextUsage } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import {
  buildContextUsageBreakdownView,
  formatBreakdownPercentage,
  formatBreakdownTokens,
  type ContextUsageRow,
} from "~/lib/contextUsageBreakdown";
import { cn } from "~/lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";

export type ContextUsageBreakdownState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly usage: ProviderContextUsage };

function BreakdownRow({ row }: { row: ContextUsageRow }) {
  return (
    <div className="flex items-center gap-2 text-xs leading-5">
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-xs"
        style={{ backgroundColor: row.color }}
      />
      <span className={cn("min-w-0 flex-1 truncate", row.free && "text-muted-foreground")}>
        {row.name}
      </span>
      <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
        {formatBreakdownTokens(row.tokens)}
      </span>
      <span className="w-12 shrink-0 text-right font-medium tabular-nums">
        {formatBreakdownPercentage(row.percentage)}
      </span>
    </div>
  );
}

function BreakdownGroup({ group }: { group: ProviderContextUsage["groups"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1 rounded-sm text-xs leading-5 hover:text-foreground">
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-left">{group.label}</span>
        <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
          {formatBreakdownTokens(group.tokens)}
        </span>
        <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
          {group.items.length}
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="flex flex-col pb-1 pl-4">
          {group.items.map((item) => (
            <div
              key={`${item.name}:${item.detail ?? ""}`}
              className="flex items-center gap-2 text-xs leading-5"
            >
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {item.name}
                {item.detail ? (
                  <span className="text-muted-foreground/70"> · {item.detail}</span>
                ) : null}
              </span>
              <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                {formatBreakdownTokens(item.tokens)}
              </span>
              <span className="w-12 shrink-0" />
            </div>
          ))}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** Per-category view of what fills the context window. */
export function ContextUsageBreakdown({ state }: { state: ContextUsageBreakdownState }) {
  if (state.status === "loading") {
    return (
      <div className="text-xs leading-4 text-muted-foreground">Reading context breakdown…</div>
    );
  }
  if (state.status === "error") {
    return <div className="text-xs leading-4 text-muted-foreground">{state.message}</div>;
  }

  const view = buildContextUsageBreakdownView(state.usage);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {formatBreakdownTokens(view.totalTokens)} / {formatBreakdownTokens(view.maxTokens)} ·{" "}
          {formatBreakdownPercentage(view.usedPercentage)} used
        </p>
        <span className="text-2xs tabular-nums text-muted-foreground">{view.model}</span>
      </div>
      <div
        className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted/60"
        role="img"
        aria-label={`Context window ${formatBreakdownPercentage(view.usedPercentage)} used`}
      >
        {view.segments.map((segment) => (
          <div
            key={segment.name}
            className="h-full min-w-px"
            style={{
              width: `${segment.percentage ?? 0}%`,
              backgroundColor: segment.color,
            }}
          />
        ))}
      </div>
      <div className="flex flex-col">
        {view.rows.map((row) => (
          <BreakdownRow key={row.name} row={row} />
        ))}
      </div>
      {view.groups.length > 0 ? (
        <div className="flex flex-col border-t border-border/60 pt-1.5">
          {view.groups.map((group) => (
            <BreakdownGroup key={group.label} group={group} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
