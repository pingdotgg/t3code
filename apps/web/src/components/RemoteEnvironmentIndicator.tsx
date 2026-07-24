import type { LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

export function RemoteEnvironmentIndicator({
  icon: Icon,
  label,
  className,
  iconClassName,
  ...props
}: ComponentProps<"span"> & {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly iconClassName?: string;
}) {
  return (
    <span
      role="img"
      aria-label={`Remote environment: ${label}`}
      className={cn("inline-flex min-w-0 items-center gap-1", className)}
      {...props}
    >
      <span className="thread-remote-environment-label min-w-0 max-w-20 truncate">{label}</span>
      <Icon aria-hidden className={cn("shrink-0", iconClassName)} />
    </span>
  );
}

export function shouldShowRemoteEnvironmentIndicator(input: {
  readonly currentEnvironmentId: string | null;
  readonly threadEnvironmentId: string;
  readonly isDesktopLocal: boolean;
}) {
  return (
    input.currentEnvironmentId !== null &&
    input.threadEnvironmentId !== input.currentEnvironmentId &&
    !input.isDesktopLocal
  );
}
