import { SymbolView } from "../../components/AppSymbol";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import Animated, { FadeInUp, FadeOutDown } from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import type { WorkspaceState } from "../../state/workspaceModel";
import {
  workspaceConnectionStatusLabel,
  workspaceConnectionStatusPresentation,
} from "./workspace-connection-status";

const TRANSIENT_STATUS_DELAY_MS = 350;

export function WorkspaceConnectionStatus(props: {
  readonly state: WorkspaceState;
  readonly onPress: () => void;
  readonly variant?: "floating" | "sidebar";
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  const isSynchronizing =
    props.state.networkStatus !== "offline" &&
    props.state.connectionError === null &&
    (props.state.connectingEnvironments.length > 0 || props.state.hasPendingShellSnapshot);
  const variant = props.variant ?? "floating";

  return (
    <Pressable
      accessibilityHint="Opens environment settings"
      accessibilityLabel={workspaceConnectionStatusLabel(props.state)}
      accessibilityLiveRegion="polite"
      accessibilityRole="button"
      onPress={props.onPress}
      className={
        variant === "sidebar"
          ? "mx-3 flex-row items-center gap-2 rounded-xl bg-subtle px-3 py-2.5"
          : "flex-row items-center gap-2 rounded-full bg-card px-4 py-2.5"
      }
      style={
        variant === "floating"
          ? {
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 10 },
              shadowOpacity: 0.12,
              shadowRadius: 24,
            }
          : undefined
      }
    >
      {isSynchronizing ? (
        <ActivityIndicator color={iconColor} size="small" />
      ) : (
        <SymbolView name="wifi.slash" size={15} tintColor={iconColor} type="monochrome" />
      )}
      <Text className="min-w-0 flex-1 text-sm font-t3-bold text-foreground" numberOfLines={1}>
        {workspaceConnectionStatusLabel(props.state)}
      </Text>
      {variant === "sidebar" ? (
        <SymbolView name="chevron.right" size={11} tintColor={iconColor} type="monochrome" />
      ) : null}
    </Pressable>
  );
}

/**
 * Connection chrome that never participates in list or empty-state layout.
 * Transient recovery is delayed to suppress healthy sub-350ms reconnect
 * flashes; persistent and actionable states appear immediately.
 */
export function WorkspaceConnectionStatusOverlay(props: {
  readonly state: WorkspaceState;
  readonly onPress: () => void;
  readonly bottomOffset: number;
}) {
  const presentation = workspaceConnectionStatusPresentation(props.state);
  const [presented, setPresented] = useState(presentation === "immediate");
  const [displayedState, setDisplayedState] = useState(props.state);

  useEffect(() => {
    if (presentation !== "hidden") {
      setDisplayedState(props.state);
    }
  }, [presentation, props.state]);

  useEffect(() => {
    if (presentation === "hidden") {
      setPresented(false);
      return;
    }
    if (presentation === "immediate" || presented) {
      setPresented(true);
      return;
    }
    const timeout = setTimeout(() => setPresented(true), TRANSIENT_STATUS_DELAY_MS);
    return () => clearTimeout(timeout);
  }, [presentation, presented]);

  if (!presented) return null;

  return (
    <View
      className="absolute inset-x-4 z-20 items-center"
      pointerEvents="box-none"
      style={{ bottom: props.bottomOffset }}
    >
      <Animated.View
        className="w-full max-w-[430px]"
        entering={FadeInUp.duration(180)}
        exiting={FadeOutDown.duration(140)}
      >
        <WorkspaceConnectionStatus state={displayedState} onPress={props.onPress} />
      </Animated.View>
    </View>
  );
}
