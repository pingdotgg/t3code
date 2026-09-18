import type { ViewStyle } from "react-native";
import type { MobileThemeVariables } from "../../lib/mobileTheme";

export const THREAD_LIST_V2_MONO_FONT = "monospace";
export const THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME = "px-3 py-2.5";
export const THREAD_LIST_V2_ROW_DIVIDERS = false;

export const selectedThreadRowColors = {
  foregroundClassName: "text-thread-selected-foreground",
  mutedForegroundClassName: "text-thread-selected-foreground-muted",
  iconTintClassName: "accent-thread-selected-foreground",
  mutedIconTintClassName: "accent-thread-selected-foreground-muted",
};

export function getThreadListV2NewBranchMenuTitle(branch: string) {
  return `New thread on ${branch}`;
}

export function getThreadListV2RowAppearance(
  theme: MobileThemeVariables,
  sidebarPane: boolean,
  selected: boolean,
) {
  const selectedBackgroundColor = theme["--color-thread-selected"];
  const style: ViewStyle = {
    backgroundColor: selected ? selectedBackgroundColor : theme["--color-screen"],
    borderRadius: 20,
  };
  const swipeContainerStyle: ViewStyle = {
    borderRadius: 20,
    overflow: "hidden",
    marginHorizontal: 8,
    marginVertical: 2,
  };

  return {
    className: undefined,
    interactionClassName: selected ? "bg-thread-selected-foreground" : "bg-primary",
    style,
    cardStyle: sidebarPane ? { ...style, paddingHorizontal: 12, paddingVertical: 10 } : style,
    swipeContainerStyle,
    swipeBackgroundColor: theme["--color-screen"],
    providerIconSurfaceColor:
      sidebarPane && selected ? selectedBackgroundColor : theme["--color-screen"],
  };
}
