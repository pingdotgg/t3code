import type { GitButlerDiscoveryItem } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { GitBranchIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Badge } from "~/components/ui/badge";
import { Switch } from "~/components/ui/switch";

export function GitButlerDiscoveryRow({ item }: { readonly item: GitButlerDiscoveryItem }) {
  const version = Option.getOrNull(item.version);
  const detail = Option.getOrNull(item.detail);
  const isAvailable = item.status === "available";
  const badge =
    item.status === "incompatible"
      ? "Update required"
      : item.status === "error"
        ? "Check failed"
        : item.status === "missing"
          ? "Not installed"
          : null;
  const summary =
    item.status === "available"
      ? "Available on this server. Open GitButler from a project thread to inspect a configured workspace."
      : item.status === "missing"
        ? item.installHint
        : (detail ?? `GitButler ${item.minimumVersion} or newer is required.`);

  return (
    <div className="rounded-xl px-3 py-3 transition-colors hover:bg-muted/20 sm:px-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
              <GitBranchIcon className="size-4.5 text-foreground/80" aria-hidden />
              <span
                className={cn(
                  "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
                  isAvailable ? "bg-success" : "bg-warning",
                )}
                aria-hidden
              />
            </span>
            <span className="truncate text-sm font-medium tracking-[-0.005em] text-foreground">
              {item.label}
            </span>
            {version ? <code className="text-xs text-muted-foreground">{version}</code> : null}
            {badge ? (
              <Badge variant="warning" size="sm">
                {badge}
              </Badge>
            ) : null}
          </div>
          <p className="text-[13px] leading-[1.45] text-muted-foreground/80">{summary}</p>
        </div>
        <Switch checked={isAvailable} disabled aria-label="GitButler availability" />
      </div>
    </div>
  );
}
