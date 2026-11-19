import { msg } from "gt-react-native";
import type { ViewStyle } from "react-native";

import { m, type MessageResolver } from "../../i18n/messages";
import type { MobileThemeVariables } from "../../lib/mobileTheme";

export const THREAD_LIST_V2_MONO_FONT = "monospace";
export const THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME = "px-3 py-2.5";
/** Thread rows are already bordered tiles (see the row style), so they need no frame. */
export const THREAD_LIST_V2_ROW_FRAME_CLASS_NAME = undefined;
/** Queued-task rows are not tiles, so they get the bordered frame. */
export const THREAD_LIST_V2_PENDING_ROW_FRAME_CLASS_NAME =
  "mx-2 my-0.5 overflow-hidden rounded-[20px] border border-border";
export const THREAD_LIST_V2_SIDEBAR_ROW_STYLE = {
  borderRadius: 20,
  paddingHorizontal: 12,
  paddingVertical: 10,
} satisfies ViewStyle;
export const THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE = {
  borderRadius: 20,
  overflow: "hidden",
  marginHorizontal: 8,
  marginVertical: 2,
} satisfies ViewStyle;

export const selectedThreadRowColors = {
  foregroundClassName: "text-thread-selected-foreground",
  mutedForegroundClassName: "text-thread-selected-foreground-muted",
  iconTintClassName: "accent-thread-selected-foreground",
  mutedIconTintClassName: "accent-thread-selected-foreground-muted",
};

export function getThreadListV2NewBranchMenuTitle(branch: string, resolve: MessageResolver = m) {
  return resolve(msg("New thread on {branch}", { branch }));
}

export function getThreadListV2RowAppearance(
  theme: MobileThemeVariables,
  sidebarPane: boolean,
  selected: boolean,
) {
  const selectedBackgroundColor = theme["--color-thread-selected"];
  const backgroundColor = theme[sidebarPane ? "--color-drawer" : "--color-screen"];
  const style: ViewStyle = {
    backgroundColor: selected ? selectedBackgroundColor : backgroundColor,
    borderRadius: THREAD_LIST_V2_SIDEBAR_ROW_STYLE.borderRadius,
    borderWidth: 1,
    borderColor: theme["--color-border"],
  };
  const swipeContainerStyle = THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE;

  return {
    className: undefined,
    interactionClassName: sidebarPane ? "bg-thread-hover" : "bg-row-hover",
    interactionOpacity: selected ? 0 : 1,
    foregroundClassName: sidebarPane ? "text-drawer-foreground" : "text-foreground",
    mutedForegroundClassName: sidebarPane
      ? "text-drawer-foreground-muted"
      : "text-foreground-muted",
    tertiaryForegroundClassName: sidebarPane
      ? "text-drawer-foreground-muted"
      : "text-foreground-tertiary",
    mutedIconTintClassName: sidebarPane
      ? "accent-drawer-foreground-muted"
      : "accent-foreground-muted",
    tertiaryIconTintClassName: sidebarPane
      ? "accent-drawer-foreground-muted"
      : "accent-foreground-tertiary",
    style,
    cardStyle: sidebarPane ? { ...style, ...THREAD_LIST_V2_SIDEBAR_ROW_STYLE } : style,
    swipeContainerStyle,
    swipeBackgroundColor: backgroundColor,
    providerIconSurfaceColor: selected ? selectedBackgroundColor : backgroundColor,
  };
}
