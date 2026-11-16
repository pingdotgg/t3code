import type { ReactNode } from "react";
import { Pressable, View, type ColorValue } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { ShimmeringWorkContent } from "./thread-work-log";

export function ThreadContextDivider(props: {
  label: string;
  icon?: AppSymbolName;
  iconColor: ColorValue;
  active?: boolean;
  failed?: boolean;
  children?: ReactNode;
}) {
  return (
    <View className="mb-3 flex-row items-center gap-3 px-1 py-1">
      <View className="h-px min-w-4 flex-1 bg-separator" />
      <View className="shrink flex-row flex-wrap items-center justify-center gap-1.5">
        {/* One row, so a long label wraps beside its icon instead of under it. */}
        <View className="shrink flex-row items-center gap-1.5">
          {props.icon ? (
            <SymbolView name={props.icon} size={12} tintColor={props.iconColor} type="monochrome" />
          ) : null}
          {props.active ? (
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
                  ? "shrink font-t3-medium text-xs text-danger-foreground"
                  : "shrink font-t3-medium text-xs text-foreground-muted"
              }
            >
              {props.label}
            </Text>
          )}
        </View>
        {props.children}
      </View>
      <View className="h-px min-w-4 flex-1 bg-separator" />
    </View>
  );
}

export interface ThreadLifecycleEvent {
  readonly state: "snoozed" | "settled" | "woke";
  readonly label: string;
  readonly action: {
    readonly label: string;
    readonly accessibilityLabel: string;
    readonly disabled: boolean;
    readonly onPress: () => void;
  };
}

/** Closes the feed while the thread is snoozed, settled, or just woke. Left-aligned, as on web. */
export function ThreadLifecycleLine(props: {
  readonly event: ThreadLifecycleEvent;
  readonly iconColor: ColorValue;
}) {
  const { action } = props.event;
  return (
    <View className="mb-3 flex-row items-center gap-1.5 px-1 py-1">
      <SymbolView
        name={props.event.state === "settled" ? "checkmark.circle" : "alarm"}
        size={13}
        tintColor={props.iconColor}
        type="monochrome"
      />
      <Text className="shrink font-t3-medium text-xs text-foreground-muted" numberOfLines={1}>
        {props.event.label}
      </Text>
      <Text className="text-xs text-foreground-muted">·</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={action.accessibilityLabel}
        accessibilityState={{ disabled: action.disabled }}
        disabled={action.disabled}
        onPress={action.onPress}
        hitSlop={8}
        className={`active:opacity-70 ${action.disabled ? "opacity-50" : ""}`}
      >
        <Text className="font-t3-medium text-xs text-foreground">{action.label}</Text>
      </Pressable>
    </View>
  );
}
