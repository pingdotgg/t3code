import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

import { SymbolView } from "../../components/AppSymbol";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import type { WorkspaceState } from "../../state/workspaceModel";
import {
  workspaceConnectionHeaderPresentation,
  workspaceConnectionStatusLabel,
} from "./workspace-connection-status";

export function WorkspaceConnectionStatus(props: {
  readonly state: WorkspaceState;
  readonly onPress: () => void;
  readonly onReconnect?: () => void;
  readonly environmentLabel?: string;
  readonly environmentConnectionState?: EnvironmentConnectionPhase;
  readonly fallback?: ReactNode;
  readonly variant?: "floating" | "header" | "sidebar";
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  if (props.variant === "header") {
    const presentation = workspaceConnectionHeaderPresentation(
      props.state,
      props.environmentLabel,
      props.environmentConnectionState,
    );
    if (presentation === null) return <>{props.fallback}</>;

    const tintColor = presentation.tone === "amber" ? "#fbbf24" : "#f87171";
    const label = `${presentation.label} ${presentation.detail}`;
    return (
      <View className="h-12 min-w-0 flex-row items-center gap-2.5">
        <Pressable
          accessibilityHint="Opens environment settings"
          accessibilityLabel={label}
          accessibilityRole="button"
          className="min-w-0 flex-1 flex-row items-center gap-2.5 self-stretch"
          onPress={props.onPress}
        >
          <SymbolView
            name={
              presentation.tone === "amber" ? "point.3.connected.trianglepath.dotted" : "wifi.slash"
            }
            size={17}
            tintColor={tintColor}
            type="monochrome"
          />
          <Text
            className="min-w-0 shrink text-base font-t3-bold"
            numberOfLines={1}
            style={{ color: tintColor }}
          >
            {presentation.label}{" "}
            <Text className="text-sm font-t3-medium" style={{ color: tintColor, opacity: 0.72 }}>
              {presentation.detail}
            </Text>
          </Text>
        </Pressable>
        {presentation.tone === "red" && props.onReconnect ? (
          <Pressable
            accessibilityLabel={`Reconnect ${presentation.label}`}
            accessibilityRole="button"
            hitSlop={8}
            onPress={props.onReconnect}
          >
            <Text className="text-xs font-t3-bold" style={{ color: tintColor }}>
              Reconnect
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const isSynchronizing =
    props.state.networkStatus !== "offline" &&
    props.state.connectionError === null &&
    (props.state.connectingEnvironments.length > 0 || props.state.hasPendingShellSnapshot);
  const variant = props.variant ?? "floating";

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
        <SymbolView
          name="point.3.connected.trianglepath.dotted"
          size={15}
          tintColor={iconColor}
          type="monochrome"
        />
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
