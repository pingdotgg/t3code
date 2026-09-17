import { cn } from "../../../lib/cn";
import type { ComponentProps } from "react";
import { Platform, View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { ThemedSwitch } from "../../../components/ThemedSwitch";

type SymbolName = ComponentProps<typeof SymbolView>["name"];

export function SettingsSwitchRow(props: {
  readonly disabled?: boolean;
  readonly icon: SymbolName;
  readonly label: string;
  readonly subtitle?: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  return (
    <View
      className={cn(
        "flex-row items-center gap-4",
        Platform.OS === "android" ? "min-h-14 px-4 py-3" : "p-4",
        Platform.OS === "android" && props.subtitle && "min-h-18",
        props.disabled && "opacity-[0.45]",
      )}
    >
      <SymbolView
        name={props.icon}
        size={Platform.OS === "android" ? 24 : 22}
        tintColorClassName="accent-icon"
        type="monochrome"
        weight="regular"
      />
      <View className={cn("min-w-0 flex-1", Platform.OS === "android" && "gap-1")}>
        <Text
          className={
            Platform.OS === "android" ? "text-base text-foreground" : "text-lg text-foreground"
          }
        >
          {props.label}
        </Text>
        {props.subtitle ? (
          <Text className="text-sm text-foreground-muted">{props.subtitle}</Text>
        ) : null}
      </View>
      <ThemedSwitch
        accessibilityLabel={props.label}
        disabled={props.disabled}
        onValueChange={props.onValueChange}
        value={props.value}
      />
    </View>
  );
}
