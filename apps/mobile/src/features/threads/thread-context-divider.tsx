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
      <View className="h-px min-w-2 flex-1 bg-separator" />
      <View className="shrink flex-row flex-wrap items-center justify-center gap-1.5">
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
                ? "font-t3-medium text-xs text-danger-foreground"
                : "font-t3-medium text-xs text-foreground-muted"
            }
          >
            {props.label}
          </Text>
        )}
        {props.children}
      </View>
      <View className="h-px min-w-2 flex-1 bg-separator" />
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

/** Closes the feed while the thread is snoozed, settled, or just woke. */
export function ThreadLifecycleDivider(props: {
  readonly event: ThreadLifecycleEvent;
  readonly iconColor: ColorValue;
}) {
  const { action } = props.event;
  return (
    <ThreadContextDivider
      label={props.event.label}
      icon={props.event.state === "settled" ? "checkmark.circle" : "clock"}
      iconColor={props.iconColor}
    >
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
    </ThreadContextDivider>
  );
}
