export interface SegmentedControlProps<Value extends number | string> {
  readonly options: readonly {
    readonly value: Value;
    readonly label: string;
    readonly accessibilityLabel?: string;
  }[];
  readonly selected: Value;
  readonly onSelect: (value: Value) => void;
  /** Large provides 44-point targets; compact and default use smaller capsules. */
  readonly size?: "default" | "compact" | "large";
  readonly variant?: "standalone" | "card";
  readonly role?: "tab" | "button";
  readonly className?: string;
}
