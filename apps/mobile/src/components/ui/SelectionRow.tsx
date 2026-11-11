import type { ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";

import { cn } from "../../lib/cn";
import { SymbolView, type AppSymbolName } from "./AppSymbol";
import { AppText as Text } from "./AppText";
import { NavigationRow } from "./NavigationRow";

/** A picker row in a grouped list; the first and last rows round the group's corners. */
export function SelectionRow(props: {
  readonly icon?: AppSymbolName;
  /** Drawn where the icon goes, for marks a symbol can't express (a label's color dot). */
  readonly leading?: ReactNode;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly selected: boolean;
  /** "checkbox" when several rows can be selected at once. */
  readonly role?: "radio" | "checkbox";
  readonly isFirst?: boolean;
  readonly isLast?: boolean;
  readonly subtitle?: string;
  readonly title: string;
}) {
  const role = props.role ?? "radio";
  const row =
    Platform.OS === "android" ? (
      <NavigationRow
        className="bg-grouped-card"
        title={props.title}
        subtitle={props.subtitle}
        leading={
          props.icon ? (
            <SymbolView name={props.icon} size={24} tintColorClassName="accent-icon-muted" />
          ) : (
            props.leading
          )
        }
        trailing={
          props.selected ? (
            <SymbolView name="checkmark" size={20} tintColorClassName="accent-focus" />
          ) : null
        }
        accessibilityRole={role}
        accessibilityState={{ checked: props.selected }}
        disabled={props.disabled}
        onPress={props.onPress}
      />
    ) : (
      <Pressable
        accessibilityLabel={[props.title, props.subtitle].filter(Boolean).join(", ")}
        accessibilityRole={role}
        accessibilityState={{ checked: props.selected }}
        className={cn(
          "min-h-14 flex-row items-center gap-3 bg-grouped-card px-4 py-3 active:bg-subtle",
          !props.isLast && "border-b border-border-subtle",
        )}
        disabled={props.disabled}
        onPress={props.onPress}
        style={{ opacity: props.disabled ? 0.45 : 1 }}
      >
        {props.icon ? (
          <SymbolView
            name={props.icon}
            size={17}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        ) : (
          (props.leading ?? null)
        )}
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
            {props.title}
          </Text>
          {props.subtitle ? (
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {props.subtitle}
            </Text>
          ) : null}
        </View>
        {props.selected ? (
          <SymbolView
            name="checkmark"
            size={16}
            tintColorClassName="accent-icon"
            type="monochrome"
            weight="semibold"
          />
        ) : null}
      </Pressable>
    );
  if (!props.isFirst && !props.isLast) return row;
  return (
    <View
      className={cn(
        "overflow-hidden",
        props.isFirst && (Platform.OS === "android" ? "rounded-t-[28px]" : "rounded-t-2xl"),
        props.isLast && (Platform.OS === "android" ? "rounded-b-[28px]" : "rounded-b-2xl"),
      )}
    >
      {row}
    </View>
  );
}
