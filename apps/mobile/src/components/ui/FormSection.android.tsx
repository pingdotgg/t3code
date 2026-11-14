import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "./AppText";
import type { FormFieldProps, FormSectionProps } from "./FormSection.types";
export type { FormFieldProps, FormSectionProps } from "./FormSection.types";

export function FormSection(props: FormSectionProps) {
  return (
    <View className="gap-3 rounded-[20px] bg-card p-4">
      <Text className="text-base font-t3-medium text-foreground">{props.title}</Text>
      {props.children}
    </View>
  );
}

export function FormField({ label, ...props }: FormFieldProps) {
  return (
    <>
      {label ? <Text className="text-sm text-foreground-secondary">{label}</Text> : null}
      <TextInput {...props} className="rounded-xl bg-sheet-solid" />
    </>
  );
}
