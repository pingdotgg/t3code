import { ActivityIndicator, Pressable, View } from "react-native";

import { SymbolView, type SFSymbol } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import type { WorkspaceState } from "../../state/workspaceModel";
import { useSettledWorkspaceSyncTone } from "./use-settled-workspace-sync-tone";
import {
  workspaceConnectionStatusLabel,
  type WorkspaceSyncTone,
} from "./workspace-connection-status";

/**
 * SF Symbol for a settled tone, or null when the tone is shown as a spinner
 * instead. Exported so the iOS native header-item builders (which can only
 * carry an icon name, not a React child) can style their own button the same way.
 */
export function workspaceSyncToneSymbol(tone: WorkspaceSyncTone): SFSymbol | null {
  switch (tone) {
    case "offline":
      return "wifi.slash";
    case "error":
    case "disconnected":
      return "exclamationmark.triangle";
    case "connecting":
    case "syncing":
      // Rendered as an ActivityIndicator in React headers; native header items
      // fall back to this icon since they can't host a spinner.
      return "arrow.clockwise";
    case "idle":
      return null;
  }
}

/**
 * Header button reporting workspace connection / thread-sync state.
 *
 * Replaces the old inline WorkspaceConnectionStatus row that lived inside the
 * thread list's scroll view, where every sync-state flip mounted and unmounted
 * a list header — flashing the indicator and reflowing every row beneath it.
 * Here the button's slot is always occupied (idle renders an empty box of the
 * same size), so state changes swap the icon without moving anything, and the
 * tone itself is settled first (see useSettledWorkspaceSyncTone) so the
 * inherently bouncy sync signal can't strobe the header.
 */
export function WorkspaceSyncStatusButton(props: {
  readonly state: WorkspaceState;
  readonly onPress: () => void;
  /**
   * "home" matches the Android home header's circular 44pt buttons;
   * "sidebar-grouped" matches the split-view sidebar's shared capsule group.
   */
  readonly variant?: "home" | "sidebar-grouped";
}) {
  const tone = useSettledWorkspaceSyncTone(props.state);
  const iconColor = useThemeColor("--color-icon");
  const pressedBackgroundColor = useThemeColor("--color-subtle");
  const variant = props.variant ?? "home";
  const isGrouped = variant === "sidebar-grouped";
  const sizeClassName = isGrouped ? "h-11 w-[50px] rounded-[22px]" : "size-11 rounded-full";
  const symbol = workspaceSyncToneSymbol(tone);
  const isBusy = tone === "connecting" || tone === "syncing";

  // Idle keeps the slot — an empty box the exact size of the button — so the
  // neighbouring header controls never shift when sync state changes.
  if (tone === "idle") {
    return <View className={sizeClassName} pointerEvents="none" />;
  }

  const label = workspaceConnectionStatusLabel(props.state);

  return (
    <Pressable
      accessibilityHint="Opens environment settings"
      accessibilityLabel={label}
      accessibilityRole="button"
      hitSlop={4}
      onPress={props.onPress}
      // Home mirrors the sibling filter/settings circles (bg-subtle); the
      // sidebar variant drops its own chrome to sit inside the shared capsule.
      className={cn(sizeClassName, "items-center justify-center", !isGrouped && "bg-subtle")}
      style={({ pressed }) => (pressed ? { backgroundColor: pressedBackgroundColor } : undefined)}
    >
      {isBusy ? (
        <ActivityIndicator color={iconColor} size="small" />
      ) : symbol ? (
        <SymbolView
          name={symbol}
          size={isGrouped ? 20 : 18}
          tintColor={iconColor}
          type="monochrome"
        />
      ) : null}
    </Pressable>
  );
}
