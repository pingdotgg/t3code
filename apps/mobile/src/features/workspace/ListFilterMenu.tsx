import { Pressable } from "react-native";
import { Chip } from "../../components/Chip";
import { Menu } from "../../components/Menu";
import type { MenuProps } from "../../components/Menu.types";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/** A visible filter with a native menu containing only that filter's choices. */
export function ListFilterMenu(props: {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly active?: boolean;
  readonly icon?: boolean;
  readonly actions: MenuProps["actions"];
  readonly onSelect: (id: string) => void;
}) {
  const { themeAppearance } = useAppearancePreferences();
  return (
    <Menu
      title={props.accessibilityLabel}
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        accessibilityState={{ selected: Boolean(props.active) }}
        hitSlop={6}
      >
        <Chip
          label={props.label}
          selected={props.active}
          icon={props.icon ? "line.3.horizontal.decrease" : undefined}
          trailingIcon={props.icon ? undefined : "chevron.down"}
          glass
          colorScheme={themeAppearance}
        />
      </Pressable>
    </Menu>
  );
}
