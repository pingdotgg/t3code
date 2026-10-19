import type { StyleProp, ViewStyle } from "react-native";
import type { AppSymbolName } from "./AppSymbol";

export type FloatingActionButtonProps = {
  readonly onPress: () => void;
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly variant?: "extended" | "large";
  readonly expanded?: boolean;
  readonly tone?: "primary" | "secondary";
  readonly className?: string;
  readonly style?: StyleProp<ViewStyle>;
};
