import type { ReactNode } from "react";
import { View, type ColorValue } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { ShimmeringWorkContent } from "./thread-work-log";

/**
 * A label centered between two thin lines. Leave out `icon` and `iconColor`
 * for a static text-only divider; the `active` shimmer needs `iconColor`.
 * `accessibilityLabel` makes the whole divider one element that reads as that
 * label instead of the visible text.
 */
export function ThreadContextDivider(props: {
  label: string;
  icon?: AppSymbolName;
  iconColor?: ColorValue;
  active?: boolean;
  failed?: boolean;
  accessibilityLabel?: string;
  children?: ReactNode;
}) {
  return (
    <View
      accessible={props.accessibilityLabel !== undefined}
      accessibilityLabel={props.accessibilityLabel}
      className="mb-3 flex-row items-center gap-3 px-1 py-1"
    >
      <View className="h-px min-w-2 flex-1 bg-adaptive-neutral-200-a80-white-a8" />
      <View className="shrink flex-row flex-wrap items-center justify-center gap-1.5">
        {props.icon !== undefined && props.iconColor !== undefined ? (
          <SymbolView name={props.icon} size={12} tintColor={props.iconColor} type="monochrome" />
        ) : null}
        {props.active && props.iconColor !== undefined ? (
          <ShimmeringWorkContent
            className="flex-none"
            textClassName="font-t3-medium"
            compact
            icon="brain"
            iconSubtleColor={props.iconColor}
            label={props.label}
            showIcon={false}
          />
        ) : (
          <Text
            className={
              props.failed
                ? "font-t3-medium text-xs text-danger-foreground"
                : "font-t3-medium text-xs text-foreground-muted"
            }
          >
            {props.label}
          </Text>
        )}
        {props.children}
      </View>
      <View className="h-px min-w-2 flex-1 bg-adaptive-neutral-200-a80-white-a8" />
    </View>
  );
}
