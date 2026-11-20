import type { MenuAction } from "@react-native-menu/menu";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";

export type RegisteredServerMenuProps = {
  readonly actions: MenuAction[];
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
  readonly onPressAction: () => void;
};

export function RegisteredServerMenu(props: RegisteredServerMenuProps) {
  return (
    <Menu actions={props.actions} isAnchoredToRight onPressAction={props.onPressAction}>
      <Pressable
        accessibilityLabel={props.accessibilityLabel}
        accessibilityRole="button"
        disabled={props.disabled}
        className="size-[30px] items-center justify-center active:opacity-60 disabled:opacity-50"
      >
        <View className="rotate-90">
          <SymbolView
            name="ellipsis"
            size={18}
            tintColorClassName={"accent-clerk-foreground-muted"}
            type="monochrome"
          />
        </View>
      </Pressable>
    </Menu>
  );
}
