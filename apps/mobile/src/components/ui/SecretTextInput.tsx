import { AppTextInput } from "./AppText";
import type { SecretTextInputProps } from "./SecretTextInput.types";

/** Masked field for a value that must stay out of password managers and suggestions. */
export function SecretTextInput({ onMount, ...props }: SecretTextInputProps) {
  const returnKeyType = props.returnKeyType ?? "done";
  return (
    <AppTextInput
      ref={onMount}
      accessibilityLabel={props.accessibilityLabel}
      className={props.className}
      placeholder={props.placeholder}
      value={props.value}
      onChangeText={props.onChangeText}
      editable={props.editable}
      secureTextEntry={props.revealed !== true}
      autoCorrect={false}
      autoCapitalize="none"
      autoComplete="off"
      textContentType="none"
      importantForAutofill="no"
      spellCheck={false}
      returnKeyType={returnKeyType}
      submitBehavior={returnKeyType === "next" ? "submit" : "blurAndSubmit"}
      onSubmitEditing={(event) => props.onSubmitEditing(event.nativeEvent.text)}
    />
  );
}
