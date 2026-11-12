import type { MenuAction } from "@react-native-menu/menu";
import type { AppSymbolName } from "./AppSymbol";

export interface SplitButtonProps {
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly icon?: AppSymbolName;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly onPress: () => void;
  readonly menuTitle: string;
  readonly actions: MenuAction[];
  readonly onPressAction: (id: string) => void;
}
