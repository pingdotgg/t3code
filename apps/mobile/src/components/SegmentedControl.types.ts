export interface SegmentedControlProps<Value extends number | string> {
  readonly options: readonly {
    readonly value: Value;
    readonly label: string;
    readonly accessibilityLabel?: string;
  }[];
  readonly selected: Value;
  readonly onSelect: (value: Value) => void;
  /** Native controls determine their own sizing. Kept for existing callers. */
  readonly size?: "default" | "compact";
  /** "tab" for the view switcher; filters stay plain buttons. */
  readonly role?: "tab" | "button";
  readonly className?: string;
}
