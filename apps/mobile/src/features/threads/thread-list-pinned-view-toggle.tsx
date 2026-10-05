/**
 * The thread list's pinned view toggle, shared by the iPhone Home header, the
 * iPad sidebar and the Android toolbar. It swaps the list between the inbox
 * and pinned threads, and counts what the hidden view holds: all its threads
 * and, in blue, the ones showing an unread Done.
 */
import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { PlatformColor, View } from "react-native";

import { AndroidHeaderIconButton } from "../../components/AndroidScreenHeader";
import { AppText } from "../../components/AppText";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";

export interface ThreadListPinnedViewToggle {
  readonly pinnedView: boolean;
  readonly otherViewThreadCount: number;
  readonly otherViewDoneCount: number;
  readonly onToggle: () => void;
}

function badgeText(count: number) {
  return count > 99 ? "99+" : String(count);
}

function accessibilityLabel(toggle: ThreadListPinnedViewToggle) {
  const otherViewName = toggle.pinnedView ? "active" : "pinned";
  const threads = toggle.otherViewThreadCount === 1 ? "thread" : "threads";
  return `Pinned threads, ${toggle.otherViewThreadCount} ${otherViewName} ${threads}, ${toggle.otherViewDoneCount} unread done`;
}

/** UIKit gives a bar button one badge (iOS 26+): unread Done wins, then the
    thread count. The accessibility label always carries both. */
export function createPinnedViewHeaderItem(
  toggle: ThreadListPinnedViewToggle,
): NativeStackHeaderItem {
  const badge =
    toggle.otherViewDoneCount > 0
      ? {
          value: badgeText(toggle.otherViewDoneCount),
          style: { backgroundColor: PlatformColor("systemBlue"), color: "white" },
        }
      : toggle.otherViewThreadCount > 0
        ? {
            value: badgeText(toggle.otherViewThreadCount),
            style: { backgroundColor: PlatformColor("systemGray"), color: "white" },
          }
        : undefined;
  return withNativeGlassHeaderItem({
    type: "button",
    label: "",
    accessibilityLabel: accessibilityLabel(toggle),
    icon: { type: "sfSymbol", name: toggle.pinnedView ? "pin.fill" : "pin" } as const,
    selected: toggle.pinnedView,
    onPress: toggle.onToggle,
    ...(badge === undefined ? {} : { badge }),
  });
}

/** Android toolbar button. Bubbles overlay its corners so counts never move
    the toolbar: unread Done on top, all threads in the other view below. */
export function AndroidPinnedViewToggleButton(props: {
  readonly toggle: ThreadListPinnedViewToggle;
}) {
  const { toggle } = props;
  return (
    <View>
      <AndroidHeaderIconButton
        accessibilityLabel={accessibilityLabel(toggle)}
        icon={toggle.pinnedView ? "pin.fill" : "pin"}
        selected={toggle.pinnedView}
        onPress={toggle.onToggle}
      />
      {toggle.otherViewDoneCount > 0 ? (
        <View
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          className="absolute top-1 right-1 h-4 min-w-4 items-center justify-center rounded-full bg-adaptive-blue-500-400 px-1"
        >
          <AppText className="text-2xs font-t3-bold text-white">
            {badgeText(toggle.otherViewDoneCount)}
          </AppText>
        </View>
      ) : null}
      {toggle.otherViewThreadCount > 0 ? (
        <View
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          className="absolute right-1 bottom-1 h-4 min-w-4 items-center justify-center rounded-full border border-border bg-header px-1"
        >
          <AppText className="text-2xs font-t3-bold text-foreground-muted">
            {badgeText(toggle.otherViewThreadCount)}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}
