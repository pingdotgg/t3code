import { View } from "react-native";
import { Chip } from "../../../components/ui/Chip";
import { Menu } from "../../../components/ui/Menu";
import type { MenuProps } from "../../../components/ui/Menu.types";
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";

export function ListFilterMenu(props: {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly active?: boolean;
  readonly icon?: boolean;
  readonly actions: MenuProps["actions"];
  readonly onSelect: (id: string) => void;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const active = Boolean(props.active);
  return (
    <Menu
      // Selection menus omit a title so the UIMenu reads like Files/Music, not an alert.
      title=""
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
      accessible
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ selected: active }}
    >
      {/* collapsable={false} keeps a real host view for MenuView's native anchor. */}
      <View collapsable={false}>
        <Chip
          label={props.label}
          selected={active}
          shape="capsule"
          icon={
            props.icon
              ? active
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease"
              : undefined
          }
          trailingIcon={props.icon ? undefined : "chevron.down"}
          glass
          colorScheme={themeAppearance}
        />
      </View>
    </Menu>
  );
}
