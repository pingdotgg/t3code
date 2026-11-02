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
        // Middle rows stay square; the first and last follow the card's corners, so a
        // search pulse ring on them stays concentric with the card.
        variant === "grouped" &&
          divided &&
          "[&>*+*]:border-t [&>*+*]:border-divider [&>[data-slot=settings-row]]:rounded-none [&>[data-slot=settings-row]:first-child]:rounded-t-card [&>[data-slot=settings-row]:last-child]:rounded-b-card",
        className,
      )}
    />
  );
}
