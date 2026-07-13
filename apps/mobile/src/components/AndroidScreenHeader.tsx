import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView, type AppSymbolName } from "./AppSymbol";
import { AppText as Text } from "./AppText";
import { cn } from "../lib/cn";
import { useThemeColor } from "../lib/useThemeColor";

export interface AndroidHeaderAction {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}

export function AndroidHeaderIconButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress?: () => void;
  readonly disabled?: boolean;
}) {
  const foregroundColor = useThemeColor("--color-foreground");
  const disabledColor = useThemeColor("--color-icon-subtle");

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      disabled={props.disabled}
      hitSlop={8}
      onPress={props.onPress}
      className={cn(
        "size-11 items-center justify-center rounded-full bg-subtle",
        props.disabled && "opacity-55",
      )}
    >
      <SymbolView
        name={props.icon}
        size={20}
        tintColor={props.disabled ? disabledColor : foregroundColor}
        type="monochrome"
      />
    </Pressable>
  );
}

export function AndroidScreenHeader(props: {
  readonly title: string;
  readonly subtitle?: string | null;
  readonly actions?: ReadonlyArray<AndroidHeaderAction>;
  readonly trailing?: ReactNode;
  readonly onBack?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const foregroundColor = useThemeColor("--color-foreground");

  return (
    <View
      className="border-b border-header-border bg-header px-3 pb-2.5"
      style={{
        paddingTop: Math.max(insets.top, 12),
      }}
    >
      <View className="min-h-12 flex-row items-center gap-2">
        {props.onBack ? (
          <Pressable
            accessibilityLabel="Navigate up"
            accessibilityRole="button"
            hitSlop={8}
            onPress={props.onBack}
            className="size-11 items-center justify-center"
          >
            <SymbolView
              name="chevron.left"
              size={24}
              tintColor={foregroundColor}
              type="monochrome"
            />
          </Pressable>
        ) : null}

        <View className={cn("min-w-0 flex-1", !props.onBack && "pl-1")}>
          <Text numberOfLines={1} className="text-lg font-t3-bold text-foreground">
            {props.title}
          </Text>
          {props.subtitle ? (
            <Text
              numberOfLines={1}
              className="mt-px text-[13px] font-t3-medium text-foreground-muted"
            >
              {props.subtitle}
            </Text>
          ) : null}
        </View>

        {props.actions?.map((action) => (
          <AndroidHeaderIconButton
            key={action.accessibilityLabel}
            accessibilityLabel={action.accessibilityLabel}
            disabled={action.disabled}
            icon={action.icon}
            onPress={action.onPress}
          />
        ))}
        {props.trailing}
      </View>
    </View>
  );
}
