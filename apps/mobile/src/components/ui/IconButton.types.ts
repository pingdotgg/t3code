import type { AppSymbolName } from "./AppSymbol";

export interface IconButtonProps {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress?: () => void;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly variant?: "standard" | "primary" | "tonal" | "danger";
  readonly tintColorClassName?: string;
  /** Android only. */
  readonly iconScale?: number;
  /** iOS only. Compact is a size-8 (28pt) button for dense list rows; default is size-12. */
  readonly size?: "default" | "compact";
}
