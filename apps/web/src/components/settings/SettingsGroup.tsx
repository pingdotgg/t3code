import type { ComponentProps } from "react";

import { cn } from "../../lib/utils";

export function SettingsGroup({
  variant = "grouped",
  divided = true,
  className,
  ...props
}: ComponentProps<"div"> & {
  variant?: "grouped" | "plain";
  divided?: boolean;
}) {
  return (
    <div
      data-slot="settings-group"
      {...props}
      className={cn(
        "relative overflow-visible text-foreground",
        variant === "grouped" ? "rounded-card surface-card-settings" : "space-y-1",
        variant === "grouped" &&
          divided &&
          "*:not-first:border-t *:not-first:border-divider [&>[data-slot=settings-row]]:rounded-none",
        className,
      )}
    />
  );
}
