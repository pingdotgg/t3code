import type { ComponentProps } from "react";
import { ActivityIndicator, Platform, Pressable } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { MaterialListRow } from "../../../components/MaterialListRow";
import { cn } from "../../../lib/cn";

export function SettingsActionRow(props: {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly tone?: "default" | "danger";
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly onPress: () => void;
}) {
  const danger = props.tone === "danger";
  const textClassName = danger ? "tabular-nums text-danger-foreground" : "text-foreground";
  const iconColorClassName = danger ? "accent-danger-foreground" : "accent-icon";
  const icon = (
    <SymbolView
      name={props.icon}
      size={Platform.OS === "android" ? 24 : 22}
      tintColorClassName={iconColorClassName}
      type="monochrome"
      weight="regular"
    />
  );
  const spinner = props.loading ? <ActivityIndicator colorClassName={iconColorClassName} /> : null;

  if (Platform.OS === "android") {
    return (
      <MaterialListRow
        title={props.label}
        titleClassName={textClassName}
        leading={icon}
        trailing={spinner}
        disabled={props.disabled}
        onPress={props.onPress}
      />
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className="flex-row items-center gap-4 p-4 disabled:opacity-40"
    >
      {icon}
      <Text className={cn("flex-1 text-lg", textClassName)}>{props.label}</Text>
      {spinner}
    </Pressable>
  );
}
