import type { ReactNode } from "react";

export const actionableItemClassName =
  "group/actionable-item relative w-full min-w-0 cursor-pointer rounded-md px-2.5 py-2 text-left text-sidebar-foreground hover:bg-sidebar-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function SourceControlActionableItem({
  kind,
  icon,
  title,
  metadata,
  trailingMetadata,
  time,
  actions,
}: {
  readonly kind: string;
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly metadata: ReactNode;
  readonly trailingMetadata?: ReactNode;
  readonly time?: ReactNode;
  readonly actions: ReactNode;
}) {
  return (
    <>
      <div className="flex min-h-6 min-w-0 items-center gap-1.5 text-xs font-medium text-secondary-label">
        {icon}
        <span className="min-w-0 flex-1 truncate">{kind}</span>
        <div className="ml-auto grid shrink-0 items-center justify-items-end">
          <span className="pointer-events-none col-start-1 row-start-1 text-[11px] font-normal tabular-nums text-muted-foreground group-hover/actionable-item:opacity-0 group-focus-visible/actionable-item:opacity-0 group-has-[:focus-visible]/actionable-item:opacity-0 group-has-[[aria-busy=true]]/actionable-item:opacity-0">
            {time}
          </span>
          <div
            className="pointer-events-none col-start-1 row-start-1 flex items-center gap-0.5 opacity-0 group-hover/actionable-item:pointer-events-auto group-hover/actionable-item:opacity-100 group-focus-visible/actionable-item:pointer-events-auto group-focus-visible/actionable-item:opacity-100 group-has-[:focus-visible]/actionable-item:pointer-events-auto group-has-[:focus-visible]/actionable-item:opacity-100 group-has-[[aria-busy=true]]/actionable-item:pointer-events-auto group-has-[[aria-busy=true]]/actionable-item:opacity-100"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {actions}
          </div>
        </div>
      </div>
      <div className="mt-0.5 truncate text-sm font-medium text-foreground/90">{title}</div>
      <div className="mt-1 flex min-w-0 items-end gap-1.5 text-xs text-secondary-label">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
          {metadata}
        </div>
        <div className="ml-auto flex shrink-0 items-center justify-end gap-1.5 tabular-nums">
          {trailingMetadata}
        </div>
      </div>
    </>
  );
}
