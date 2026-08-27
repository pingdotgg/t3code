import { RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export function ClerkUserProfilePage({
  action,
  children,
  className,
  description,
  title,
}: {
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly description?: ReactNode;
  readonly title: ReactNode;
}) {
  return (
    <div className={cn("w-full min-w-0 text-foreground", className)}>
      <header className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:pr-8">
        <div className="min-w-0">
          <h2 className="text-[1.0625rem] leading-6 font-semibold">{title}</h2>
          {description ? (
            <p className="mt-1 max-w-[34rem] text-[0.8125rem] leading-[1.125rem] text-muted-foreground sm:min-h-9">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>

      {children}
    </div>
  );
}

export function ClerkUserProfileRefreshButton({
  className,
  disabled = false,
  isPending,
  onClick,
}: {
  readonly className?: string;
  readonly disabled?: boolean;
  readonly isPending: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Button
      size="sm"
      variant="secondary"
      className={cn("text-[0.8125rem]", className)}
      disabled={disabled || isPending}
      onClick={onClick}
    >
      <RefreshCwIcon aria-hidden="true" className={cn("size-3.5", isPending && "animate-spin")} />
      Refresh
    </Button>
  );
}

export function ClerkUserProfileIcon({ children }: { readonly children: ReactNode }) {
  return (
    <div
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/55 text-muted-foreground"
    >
      {children}
    </div>
  );
}

export function ClerkUserProfileRow({
  children,
  className,
  icon,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly icon: ReactNode;
}) {
  return (
    <li className={cn("border-t py-4 first:border-t-0", className)}>
      <div className="flex items-start gap-3">
        <ClerkUserProfileIcon>{icon}</ClerkUserProfileIcon>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </li>
  );
}
