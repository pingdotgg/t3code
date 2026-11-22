import type { ReactNode } from "react";
import { useGT } from "gt-react-native";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { ThemedSwitch } from "../../../components/ui/ThemedSwitch";
import { cn } from "../../../lib/cn";
import { ConnectionStatusDot } from "../../connection/ConnectionStatusDot";

/**
 * One integration in a settings list: its mark with a status dot, what state it is in, an
 * optional switch, and its own page behind the row. The layout of the Environments list's rows.
 */
export function SettingsProviderRow(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly detail?: string | null;
  readonly description: string;
  readonly ready: boolean;
  readonly separated: boolean;
  /** Opens the integration's page; a row without one only reports. */
  readonly onPress?: () => void;
  readonly toggle?: {
    readonly accessibilityLabel: string;
    readonly value: boolean;
    readonly disabled: boolean;
    readonly onValueChange: (value: boolean) => void;
  };
}) {
  const gt = useGT();
  const summary = (
    <View className="min-w-0 flex-1 gap-0.5">
      <View className="flex-row items-center gap-2 overflow-hidden">
        <View className="size-5 items-center justify-center">
          {props.icon}
          <View className="absolute -top-1 -left-1">
            <ConnectionStatusDot
              state={props.ready ? "connected" : "available"}
              pulse={false}
              size={7}
            />
          </View>
        </View>
        <Text className="shrink-0 text-base font-t3-bold leading-snug text-foreground">
          {props.label}
        </Text>
        {props.detail ? (
          <Text
            className="min-w-0 shrink font-mono text-xs text-foreground-muted"
            numberOfLines={1}
          >
            {props.detail}
          </Text>
        ) : null}
      </View>
      <Text className="text-xs text-foreground-muted" numberOfLines={2}>
        {props.description}
      </Text>
    </View>
  );
  return (
    <View
      className={cn(
        "flex-row items-center gap-3 bg-grouped-card px-4 py-3.5",
        props.separated && "border-t border-border-subtle",
      )}
    >
      {props.onPress ? (
        <Pressable
          className="min-w-0 flex-1 active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel={gt("Manage {provider}", { provider: props.label })}
          accessibilityHint={props.description}
          onPress={props.onPress}
        >
          {summary}
        </Pressable>
      ) : (
        summary
      )}
      {props.toggle ? (
        <ThemedSwitch
          accessibilityLabel={props.toggle.accessibilityLabel}
          style={{ alignSelf: "center" }}
          disabled={props.toggle.disabled}
          onValueChange={props.toggle.onValueChange}
          value={props.toggle.value}
        />
      ) : null}
      {props.onPress ? (
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onPress={props.onPress}
          style={{ minWidth: 24, minHeight: 44, alignItems: "center", justifyContent: "center" }}
        >
          <SymbolView
            name="chevron.right"
            size={12}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
        </Pressable>
      ) : null}
    </View>
  );
}
