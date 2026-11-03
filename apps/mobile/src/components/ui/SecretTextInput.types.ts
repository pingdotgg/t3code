export interface SecretTextInputProps {
  readonly accessibilityLabel: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly onSubmitEditing: () => void;
  readonly editable: boolean;
}
