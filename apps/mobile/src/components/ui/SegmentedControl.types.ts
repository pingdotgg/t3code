import type { AppSymbolName } from "./AppSymbol";

export interface SegmentedControlProps<Value extends number | string> {
  readonly options: readonly {
    readonly value: Value;
    readonly label: string;
    readonly badge?: number;
    readonly accessibilityLabel?: string;
    readonly icon?: AppSymbolName;
  }[];
  readonly selected: Value;
  readonly onSelect: (value: Value) => void;
  /** Sizing applies to the non-Material control. */
  readonly size?: "default" | "compact";
  readonly role?: "tab" | "button";
  readonly className?: string;
  readonly variant?: "default" | "tabs";
}
