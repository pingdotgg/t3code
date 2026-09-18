import type { ComponentProps, ReactNode } from "react";
import { Platform, View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { cn } from "../../../lib/cn";

export function SettingsControlRow(props: {
  readonly disabled?: boolean;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
}) {
  return (
    <View
      className={cn(
        "flex-row items-center gap-4 p-4 android:min-h-14 android:py-3",
        props.subtitle && "android:min-h-18",
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
      <View className="min-w-0 flex-1 android:gap-1">
        <Text className="text-lg text-foreground android:text-base">{props.label}</Text>
        {props.subtitle ? (
          <Text className="text-sm text-foreground-muted">{props.subtitle}</Text>
        ) : null}
      </View>
      {props.children}
    </View>
  );
}
