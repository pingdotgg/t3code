import { cn } from "../../lib/cn";

/** The thread rows' look (see thread-list-v2-row-appearance), for Bot rows above them. */
export function botRowAppearance(pane: "screen" | "sidebar", selected: boolean) {
  const sidebar = pane === "sidebar";
  return {
    className: cn(
      "mx-2 my-0.5 rounded-[20px]",
      selected ? "bg-thread-selected" : sidebar ? "bg-drawer" : "bg-screen",
    ),
    interactionClassName: sidebar ? "bg-thread-hover" : "bg-row-hover",
    interactionOpacity: selected ? 0 : 1,
    foregroundClassName: sidebar ? "text-drawer-foreground" : "text-foreground",
    mutedForegroundClassName: sidebar ? "text-drawer-foreground-muted" : "text-foreground-muted",
    mutedIconTintClassName: sidebar ? "accent-drawer-foreground-muted" : "accent-foreground-muted",
  };
}
