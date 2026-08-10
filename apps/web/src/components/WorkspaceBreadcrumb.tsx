import type { ReactNode } from "react";

import { cn } from "../lib/utils";

interface WorkspaceBreadcrumbProps {
  readonly ariaLabel: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export function WorkspaceBreadcrumb({ ariaLabel, children, className }: WorkspaceBreadcrumbProps) {
  return (
    <nav aria-label={ariaLabel} className={cn("min-w-0", className)}>
      {/* Keep the flexible container draggable in Electron. Interactive
          descendants are excluded by the shared .drag-region CSS rules. */}
      <ol className="m-0 flex min-w-0 list-none items-center gap-2 overflow-hidden p-0 sm:gap-3">
        {children}
      </ol>
    </nav>
  );
}

interface WorkspaceBreadcrumbItemProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly current?: boolean;
}

export function WorkspaceBreadcrumbItem({
  children,
  className,
  current = false,
}: WorkspaceBreadcrumbItemProps) {
  return (
    <li
      aria-current={current ? "page" : undefined}
      className={cn(
        "min-w-0 text-sm font-medium",
        current ? "text-foreground" : "shrink-0 text-muted-foreground",
        className,
      )}
    >
      {children}
    </li>
  );
}

export function WorkspaceBreadcrumbSeparator() {
  return (
    <li aria-hidden="true" className="shrink-0 text-icon-muted">
      /
    </li>
  );
}
