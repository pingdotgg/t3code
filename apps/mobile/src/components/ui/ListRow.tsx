import { Platform, View } from "react-native";

import { useResolveClassNames } from "uniwind";
import { SymbolView } from "./AppSymbol";
import { ListRowLayout, type ListRowContentProps } from "./ListRowLayout";
import { RadioIndicator } from "./RadioIndicator";
import { RowPressable } from "./RowPressable";

export function ListRow(
  props: ListRowContentProps & {
    readonly onPress: () => void;
    /** Marks the row as the chosen option while it still navigates. */
    readonly selected?: boolean;
  },
) {
  const rippleStyle = useResolveClassNames("bg-subtle-strong");
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={[props.label, props.description, props.detail].filter(Boolean).join(", ")}
      accessibilityState={{
        disabled: Boolean(props.disabled),
        ...(props.selected === undefined ? {} : { checked: props.selected }),
      }}
      disabled={props.disabled}
      onPress={props.onPress}
      android_ripple={{ color: rippleStyle.backgroundColor }}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      className="bg-grouped-card"
    >
      <ListRowLayout
        {...props}
        accessory={
          <View className="flex-row items-center gap-3">
            {props.selected === undefined ? null : (
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
            )}
            <SymbolView
              name="chevron.right"
              size={16}
              tintColorClassName="accent-chevron"
              type="monochrome"
              weight="semibold"
            />
          </View>
        }
      />
    </RowPressable>
  );
}
