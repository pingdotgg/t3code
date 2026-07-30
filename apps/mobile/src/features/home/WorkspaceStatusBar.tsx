import { ActivityIndicator, Pressable, View } from "react-native";

import { SymbolView, type SFSymbol } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import type { WorkspaceState } from "../../state/workspaceModel";
import { useSettledWorkspaceStatusBusy } from "./use-settled-workspace-status";
import { workspaceSyncStatusLabel } from "./workspace-connection-status";

/** Leading glyph for a non-busy status; busy states render a spinner instead. */
function workspaceStatusSymbol(state: WorkspaceState): SFSymbol {
  if (state.networkStatus === "offline") return "wifi.slash";
  if (state.connectionError !== null || !state.hasReadyEnvironment) {
    return "exclamationmark.triangle";
  }
  return "checkmark.circle";
}

/**
 * Workspace connection / thread-sync status, pinned above the thread list.
 *
 * This deliberately sits *outside* the list's scroll view. It used to be the
 * list's ListHeaderComponent — row 0 — so every sync-state flip mounted and
 * unmounted a row, flashing the status and shoving every thread below it down
 * and back. Pinned and always mounted, only its contents change.
 *
 * It also never goes away: at rest it reports what synced and when, so the bar
 * answers "am I up to date?" on sight instead of only appearing mid-sync. The
 * busy/quiet transition is settled first (see useSettledWorkspaceStatusBusy)
 * because the underlying sync signal toggles faster than anyone can read.
 */
export function WorkspaceStatusBar(props: {
  readonly state: WorkspaceState;
  readonly onPress: () => void;
  /** Gutter matching the surrounding list. */
  readonly className?: string;
}) {
  const isBusy = useSettledWorkspaceStatusBusy(props.state);
  const iconColor = useThemeColor("--color-icon-muted");
  const label = workspaceSyncStatusLabel(props.state);

  return (
    <View className={props.className}>
      <Pressable
        accessibilityHint="Opens environment settings"
        accessibilityLabel={label}
        accessibilityRole="button"
        onPress={props.onPress}
        className="flex-row items-center gap-2 rounded-xl bg-subtle px-3 py-2.5 active:opacity-70"
      >
        {isBusy ? (
          <ActivityIndicator color={iconColor} size="small" />
        ) : (
          <SymbolView
            name={workspaceStatusSymbol(props.state)}
            size={15}
            tintColor={iconColor}
            type="monochrome"
          />
        )}
        <Text className="min-w-0 flex-1 text-sm font-t3-bold text-foreground" numberOfLines={1}>
          {label}
        </Text>
        <SymbolView name="chevron.right" size={11} tintColor={iconColor} type="monochrome" />
      </Pressable>
    </View>
  );
}
