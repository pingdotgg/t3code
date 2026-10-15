import { Platform, View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { cn } from "../lib/cn";
import { SymbolView } from "./AppSymbol";
import { ListRowLayout } from "./ListRowLayout";
import { RadioIndicator } from "./RadioIndicator";
import { RowPressable } from "./RowPressable";

export function ListChoiceRow(props: {
  readonly label: string;
  readonly description?: string;
  readonly selected: boolean;
  readonly separated?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const rippleStyle = useResolveClassNames("bg-subtle-strong");
  return (
    <RowPressable
      accessibilityRole="radio"
      accessibilityLabel={props.label}
      accessibilityHint={props.description}
      accessibilityState={{ checked: props.selected, disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
      android_ripple={{ color: rippleStyle.backgroundColor }}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      className={cn(
        props.selected ? "bg-subtle" : "bg-grouped-card",
        props.separated && "border-t border-border-subtle",
      )}
    >
      <ListRowLayout
        label={props.label}
        description={props.description}
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
}
