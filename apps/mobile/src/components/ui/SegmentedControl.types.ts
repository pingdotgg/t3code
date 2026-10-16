export interface SegmentedControlProps<Value extends number | string> {
  readonly options: readonly {
    readonly value: Value;
    readonly label: string;
    readonly accessibilityLabel?: string;
  }[];
  readonly selected: Value;
  readonly onSelect: (value: Value) => void;
  /** Compact uses a 32-point capsule; default uses 36 points on iOS and 40 on Android. */
  readonly size?: "default" | "compact";
  /** "tab" for the view switcher; filters stay plain buttons. */
  readonly role?: "tab" | "button";
  readonly className?: string;
}
