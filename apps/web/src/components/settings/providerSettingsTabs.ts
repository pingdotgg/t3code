import { cn } from "../../lib/utils";

export function providerSettingsTabClassName(selected: boolean): string {
  return cn(
    "relative flex h-full shrink-0 cursor-pointer items-center rounded-sm px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
    selected
      ? "text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary"
      : "text-muted-foreground hover:text-foreground",
  );
}
