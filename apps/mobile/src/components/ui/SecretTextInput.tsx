import { AppTextInput } from "./AppText";
import type { SecretTextInputProps } from "./SecretTextInput.types";

/** Masked field for a value that must stay out of password managers and suggestions. */
export function SecretTextInput(props: SecretTextInputProps) {
  return (
    <AppTextInput
      accessibilityLabel={props.accessibilityLabel}
      placeholder={props.placeholder}
      style={
        props.textDirection
          ? {
              writingDirection: props.textDirection,
              textAlign: props.textDirection === "rtl" ? "right" : "left",
            }
          : undefined
      }
      value={props.value}
      onChangeText={props.onChangeText}
      editable={props.editable}
      secureTextEntry
      autoCorrect={false}
      autoCapitalize="none"
      autoComplete="off"
      textContentType="none"
      importantForAutofill="no"
      spellCheck={false}
      returnKeyType="done"
      onSubmitEditing={(event) => props.onSubmitEditing(event.nativeEvent.text)}
    />
  );
}
