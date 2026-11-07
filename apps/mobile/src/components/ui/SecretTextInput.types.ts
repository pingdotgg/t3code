export interface SecretTextInputProps {
  readonly accessibilityLabel: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  /** Receives the field's current text, so a submit never uses a stale render of it. */
  readonly onSubmitEditing: (value: string) => void;
  readonly editable: boolean;
  readonly textDirection?: "ltr" | "rtl";
}
