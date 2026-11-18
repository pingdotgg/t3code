import { msg } from "gt-react-native";
import type { ViewStyle } from "react-native";

import { m, type MessageResolver } from "../../i18n/messages";
import type { MobileThemeVariables } from "../../lib/mobileTheme";

// nckrtl shell: the card already pads its sides, so phone row content adds none.
export const THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME = "py-2.5";
// nckrtl shell: rows are rounded pills on the pane, like the desktop sidebar,
// so no hairlines between them.
export const THREAD_LIST_V2_ROW_DIVIDERS = false;
/** Phone rows inset from the screen edge so their rounded surface reads. */
export const THREAD_LIST_V2_ROW_INSET = 8;
/** Phone card side padding: with the inset, row text sits 16pt from the screen edge. */
const THREAD_LIST_V2_PHONE_ROW_PADDING_HORIZONTAL = 8;
export const THREAD_LIST_V2_SIDEBAR_ROW_STYLE = {
  borderRadius: 12,
  paddingHorizontal: 12,
  paddingVertical: 10,
} satisfies ViewStyle;
export const THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE = {
  borderRadius: 12,
  overflow: "hidden",
} satisfies ViewStyle;

export const selectedThreadRowColors = {
  foregroundClassName: "text-thread-selected-foreground",
  mutedForegroundClassName: "text-thread-selected-foreground-muted",
  iconTintClassName: "accent-thread-selected-foreground",
  mutedIconTintClassName: "accent-thread-selected-foreground-muted",
};

export function getThreadListV2NewBranchMenuTitle(_branch: string, resolve: MessageResolver = m) {
  return resolve(msg("New thread on branch"));
}

export function getThreadListV2RowAppearance(
  theme: MobileThemeVariables,
  sidebarPane: boolean,
  selected: boolean,
) {
  const selectedBackgroundColor = theme["--color-thread-selected"];
  const paneColor = theme[sidebarPane ? "--color-drawer" : "--color-screen"];
  const style: ViewStyle = {
    backgroundColor: selected ? selectedBackgroundColor : paneColor,
    borderRadius: THREAD_LIST_V2_SIDEBAR_ROW_STYLE.borderRadius,
  };
  const swipeContainerStyle: ViewStyle = sidebarPane
    ? THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE
    : {
        ...THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE,
        marginHorizontal: THREAD_LIST_V2_ROW_INSET,
      };

  return {
    className: undefined,
    interactionClassName: "bg-thread-hover",
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
    cardStyle: sidebarPane
      ? { ...style, ...THREAD_LIST_V2_SIDEBAR_ROW_STYLE }
      : {
          ...style,
          ...THREAD_LIST_V2_SIDEBAR_ROW_STYLE,
          paddingHorizontal: THREAD_LIST_V2_PHONE_ROW_PADDING_HORIZONTAL,
        },
    swipeContainerStyle,
    swipeBackgroundColor: paneColor,
    // Provider badges blend into the surface beneath them.
    providerIconSurfaceColor: selected ? selectedBackgroundColor : paneColor,
  };
}
