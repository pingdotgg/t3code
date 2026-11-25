import type { ReactNode } from "react";
import { Platform, View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { cn } from "../../lib/cn";
import { SymbolView } from "./AppSymbol";
import { ListRowLayout } from "./ListRowLayout";
import { RadioIndicator } from "./RadioIndicator";
import { RowPressable } from "./RowPressable";

export function ListChoiceRow(props: {
  readonly label: string;
  readonly leading?: ReactNode;
  readonly description?: string;
  readonly meta?: ReactNode;
  readonly trailingAction?: ReactNode;
  readonly selected: boolean;
  readonly separated?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const rippleStyle = useResolveClassNames("bg-subtle-strong");
  const rowClassName = cn("bg-grouped-card", props.separated && "border-t border-border-subtle");
  const choice = (
    <RowPressable
      accessibilityRole="radio"
      accessibilityLabel={props.label}
      accessibilityHint={props.description}
      accessibilityState={{ checked: props.selected, disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
      android_ripple={{ color: rippleStyle.backgroundColor }}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      // Like UIKit and Material lists, only the checkmark or radio marks the selected row.
      className={props.trailingAction ? "min-w-0 flex-1" : rowClassName}
    >
      <ListRowLayout
        label={props.label}
        leading={props.leading}
        description={props.description}
        meta={props.meta}
        disabled={props.disabled}
        accessory={
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            className="size-6 items-center justify-center"
          >
            {Platform.OS === "android" ? (
              <RadioIndicator selected={props.selected} />
            ) : props.selected ? (
              <SymbolView
                name="checkmark"
                size={18}
                tintColorClassName="accent-primary-text"
                type="monochrome"
                weight="semibold"
              />
            ) : null}
          </View>
        }
      />
    </RowPressable>
  );
  return props.trailingAction ? (
    <View className={cn("flex-row items-center", rowClassName)}>
      {choice}
      {props.trailingAction}
    </View>
  ) : (
    choice
  );
}
