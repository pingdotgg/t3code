export interface SecretTextInputHandle {
  readonly focus: () => void;
}

export interface SecretTextInputProps {
  readonly accessibilityLabel: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  /** Receives the field's current text, so a submit never uses a stale render of it. */
  readonly onSubmitEditing: (value: string) => void;
  readonly editable: boolean;
  /** Shows the typed text; the field stays out of password managers either way. */
  readonly revealed?: boolean;
  /** "next" keeps the keyboard open for the following field. */
  readonly returnKeyType?: "next" | "done";
  readonly className?: string;
  readonly onMount?: (handle: SecretTextInputHandle | null) => void;
}
