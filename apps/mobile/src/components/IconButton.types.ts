import type { AppSymbolName } from "./AppSymbol";

export interface IconButtonProps {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress?: () => void;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly variant?: "standard" | "primary" | "tonal" | "danger";
  readonly tintColorClassName?: string;
}
