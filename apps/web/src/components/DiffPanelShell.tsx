import type { ReactNode } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";

import { Skeleton } from "./ui/skeleton";

export type DiffPanelMode = "inline" | "sheet" | "sidebar";

function getDiffPanelHeaderRowClassName(mode: DiffPanelMode) {
  const shouldUseDragRegion = isElectron && mode !== "sheet";
  return cn(
    "flex items-center justify-between gap-2 px-4 wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
    shouldUseDragRegion
      ? "drag-region h-[52px] border-b border-border wco:h-[env(titlebar-area-height)]"
      : "h-12 wco:max-h-[env(titlebar-area-height)]",
  );
}

export function DiffPanelShell(props: {
  mode: DiffPanelMode;
  header: ReactNode;
  children: ReactNode;
}) {
  const shouldUseDragRegion = isElectron && props.mode !== "sheet";

  return (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col bg-background",
        props.mode === "inline"
          ? "w-[42vw] min-w-[360px] max-w-[560px] shrink-0 border-l border-border"
          : "w-full",
      )}
    >
      {shouldUseDragRegion ? (
        <div className={getDiffPanelHeaderRowClassName(props.mode)}>{props.header}</div>
      ) : (
        <div className="border-b border-border">
          <div className={getDiffPanelHeaderRowClassName(props.mode)}>{props.header}</div>
        </div>
      )}
      {props.children}
    </div>
  );
}

export function DiffPanelHeaderSkeleton() {
  return (
    <>
      <div className="relative min-w-0 flex-1">
        <Skeleton className="absolute left-0 top-1/2 size-6 -translate-y-1/2 rounded-md border border-border/50" />
        <Skeleton className="absolute right-0 top-1/2 size-6 -translate-y-1/2 rounded-md border border-border/50" />
        <div className="flex gap-1 overflow-hidden px-8 py-0.5">
          <Skeleton className="h-6 w-16 shrink-0 rounded-md" />
          <Skeleton className="h-6 w-24 shrink-0 rounded-md" />
          <Skeleton className="h-6 w-24 shrink-0 rounded-md max-sm:hidden" />
        </div>
      </div>
      <div className="flex shrink-0 gap-1">
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="size-7 rounded-md" />
      </div>
    </>
  );
}

export function DiffPanelLoadingState(props: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-2">
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/60 bg-card/25"
        role="status"
        aria-live="polite"
        aria-label={props.label}
      >
        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
          <Skeleton className="h-4 w-32 rounded-full" />
          <Skeleton className="ml-auto h-4 w-20 rounded-full" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-3 py-4">
          <div className="space-y-2">
            <Skeleton className="h-3 w-full rounded-full" />
            <Skeleton className="h-3 w-full rounded-full" />
            <Skeleton className="h-3 w-10/12 rounded-full" />
            <Skeleton className="h-3 w-11/12 rounded-full" />
            <Skeleton className="h-3 w-9/12 rounded-full" />
          </div>
          <span className="sr-only">{props.label}</span>
        </div>
      </div>
    </div>
  );
}
