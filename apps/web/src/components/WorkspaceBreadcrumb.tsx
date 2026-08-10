import type { ReactNode } from "react";

interface WorkspaceBreadcrumbProps {
  readonly ariaLabel: string;
  readonly current: ReactNode;
  readonly parent?: ReactNode;
}

export function WorkspaceBreadcrumb({ ariaLabel, current, parent }: WorkspaceBreadcrumbProps) {
  return (
    <nav
      aria-label={ariaLabel}
      className="flex min-w-0 items-center gap-2 overflow-hidden [-webkit-app-region:no-drag] sm:gap-3"
    >
      {parent ? (
        <>
          <span className="shrink-0 text-sm font-medium text-muted-foreground">{parent}</span>
          <span aria-hidden="true" className="shrink-0 text-icon-muted">
            /
          </span>
        </>
      ) : null}
      <span className="truncate text-sm font-medium text-foreground">{current}</span>
    </nav>
  );
}
