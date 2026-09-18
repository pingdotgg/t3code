import type { ViewStyle } from "react-native";
import type { MobileThemeVariables } from "../../lib/mobileTheme";

export const THREAD_LIST_V2_MONO_FONT = "Menlo";
export const THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME = "px-5 py-2.5";
export const THREAD_LIST_V2_ROW_DIVIDERS = true;

export const selectedThreadRowColors = {
  foregroundClassName: "text-user-bubble-foreground",
  mutedForegroundClassName: "text-user-bubble-foreground-muted",
  iconTintClassName: "accent-user-bubble-foreground",
  mutedIconTintClassName: "accent-user-bubble-foreground-muted",
};

export function getThreadListV2NewBranchMenuTitle(_branch: string) {
  return "New thread on branch";
}

export function getThreadListV2RowAppearance(
  theme: MobileThemeVariables,
  sidebarPane: boolean,
  selected: boolean,
) {
  const selectedBackgroundColor = theme["--color-user-bubble"];
  const style: ViewStyle | undefined = sidebarPane
    ? {
        backgroundColor: selected ? selectedBackgroundColor : theme["--color-drawer"],
        borderRadius: 12,
      }
    : undefined;
  const swipeContainerStyle: ViewStyle | undefined = sidebarPane
    ? { borderRadius: 12, overflow: "hidden" }
    : undefined;

  return {
    className: sidebarPane ? undefined : "bg-screen",
    interactionClassName: selected && sidebarPane ? "bg-user-bubble-foreground" : "bg-primary",
    style,
    cardStyle: sidebarPane ? { ...style, paddingHorizontal: 12, paddingVertical: 10 } : undefined,
    swipeContainerStyle,
    swipeBackgroundColor: theme[sidebarPane ? "--color-drawer" : "--color-screen"],
    // Provider badges blend into the surface beneath them.
    providerIconSurfaceColor: sidebarPane
      ? selected
        ? selectedBackgroundColor
        : theme["--color-drawer"]
      : theme["--color-screen"],
  };
}
