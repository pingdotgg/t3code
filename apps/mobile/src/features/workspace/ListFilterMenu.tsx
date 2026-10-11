import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import type { ControlPillMenuProps } from "../../components/ControlPillMenu.types";
import { cn } from "../../lib/cn";

/** A visible filter with a native menu containing only that filter's choices. */
export function ListFilterMenu(props: {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly active?: boolean;
  readonly icon?: boolean;
  readonly actions: ControlPillMenuProps["actions"];
  readonly onSelect: (id: string) => void;
}) {
  return (
    <ControlPillMenu
      title={props.accessibilityLabel}
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        className="h-11 justify-center"
      >
        <View
          className={cn(
            "h-8 flex-row items-center gap-1.5 rounded-full px-3",
            props.active ? "bg-primary" : "bg-subtle",
          )}
        >
          {props.icon ? (
            <SymbolView
              name="line.3.horizontal.decrease"
              size={15}
              tintColorClassName={props.active ? "accent-primary-foreground" : "accent-icon-muted"}
            />
          ) : null}
          <Text
            numberOfLines={1}
            className={cn(
              "max-w-[180px] text-xs font-t3-medium",
              props.active ? "text-primary-foreground" : "text-foreground-muted",
            )}
          >
            {props.label}
          </Text>
          {!props.icon ? (
            <SymbolView
              name="chevron.down"
              size={10}
              tintColorClassName={props.active ? "accent-primary-foreground" : "accent-icon-muted"}
            />
          ) : null}
        </View>
      </Pressable>
    </ControlPillMenu>
  );
}
