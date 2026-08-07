import { SymbolView } from "../../components/AppSymbol";
import { ActivityIndicator, Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { WorkspaceState } from "../../state/workspaceModel";
import { workspaceConnectionStatusLabel } from "./workspace-connection-status";

export function WorkspaceConnectionStatus(props: {
  readonly state: WorkspaceState;
  readonly onPress: () => void;
  readonly variant?: "floating" | "sidebar";
}) {
  const iconFallback = useThemeColor("--color-icon-muted");
  const subtleFallback = useThemeColor("--color-subtle");
  const foregroundFallback = useThemeColor("--color-foreground");
  const { themeColors } = useAppearancePreferences();
  const isSynchronizing =
    props.state.networkStatus !== "offline" &&
    props.state.connectionError === null &&
    (props.state.connectingEnvironments.length > 0 || props.state.hasPendingShellSnapshot);
  const variant = props.variant ?? "floating";
  const iconColor =
    variant === "sidebar" ? (themeColors?.sidebarMutedForeground ?? iconFallback) : iconFallback;
  const sidebarControlSurface = themeColors?.sidebarControlSurface ?? subtleFallback;
  const foregroundColor =
    variant === "sidebar" ? (themeColors?.sidebarForeground ?? foregroundFallback) : undefined;

  return (
    <Pressable
      accessibilityHint="Opens environment settings"
      accessibilityLabel={workspaceConnectionStatusLabel(props.state)}
      accessibilityRole="button"
      onPress={props.onPress}
      className={
        variant === "sidebar"
          ? "mx-3 flex-row items-center gap-2 rounded-xl bg-subtle px-3 py-2.5"
          : "flex-row items-center gap-2 rounded-full bg-card px-4 py-2.5"
      }
      style={[
        variant === "sidebar" ? { backgroundColor: sidebarControlSurface } : undefined,
        variant === "floating"
          ? {
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 10 },
              shadowOpacity: 0.12,
              shadowRadius: 24,
            }
          : undefined,
      ]}
    >
      {isSynchronizing ? (
        <ActivityIndicator color={iconColor} size="small" />
      ) : (
        <SymbolView name="wifi.slash" size={15} tintColor={iconColor} type="monochrome" />
      )}
      <Text
        className="min-w-0 flex-1 text-sm font-t3-bold text-foreground"
        numberOfLines={1}
        style={foregroundColor ? { color: foregroundColor } : undefined}
      >
        {workspaceConnectionStatusLabel(props.state)}
      </Text>
      {variant === "sidebar" ? (
        <SymbolView name="chevron.right" size={11} tintColor={iconColor} type="monochrome" />
      ) : null}
    </Pressable>
  );
}
