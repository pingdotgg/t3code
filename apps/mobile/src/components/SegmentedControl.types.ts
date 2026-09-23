export interface SegmentedControlProps<Value extends number | string> {
  readonly options: readonly {
    readonly value: Value;
    readonly label: string;
    readonly accessibilityLabel?: string;
  }[];
  readonly selected: Value;
  readonly onSelect: (value: Value) => void;
  /** Compact sizing applies to the non-Material control. */
  readonly size?: "default" | "compact";
  /** "tab" for the view switcher; filters stay plain buttons. */
  readonly role?: "tab" | "button";
  readonly className?: string;
}
