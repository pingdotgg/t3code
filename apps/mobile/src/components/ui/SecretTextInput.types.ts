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
  /** False shows the text with no eye toggle, for a value such as an email. Defaults to true. */
  readonly secret?: boolean;
  /** "next" keeps the keyboard open for the following field. */
  readonly returnKeyType?: "next" | "done";
  readonly onMount?: (handle: SecretTextInputHandle | null) => void;
}
