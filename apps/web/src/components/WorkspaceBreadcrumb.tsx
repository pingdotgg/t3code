import type { ReactNode } from "react";

import { cn } from "../lib/utils";

interface WorkspaceBreadcrumbProps {
  readonly ariaLabel: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export function WorkspaceBreadcrumb({ ariaLabel, children, className }: WorkspaceBreadcrumbProps) {
  return (
    <nav
      aria-label={ariaLabel}
      className={cn(
        "flex min-w-0 items-center gap-2 overflow-hidden [-webkit-app-region:no-drag] sm:gap-3",
        className,
      )}
    >
      {children}
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
    <span
      aria-current={current ? "page" : undefined}
      className={cn(
        "min-w-0 text-sm font-medium",
        current ? "text-foreground" : "shrink-0 text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function WorkspaceBreadcrumbSeparator() {
  return (
    <span aria-hidden="true" className="shrink-0 text-icon-muted">
      /
    </span>
  );
}
