import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "./AppText";
import type { FormFieldProps, FormSectionProps } from "./FormSection.types";
export type { FormFieldProps, FormSectionProps } from "./FormSection.types";

export function FormSection(props: FormSectionProps) {
  return (
    <View className="gap-2 rounded-[18px] border border-border bg-card p-4">
      <Text className="text-2xs font-t3-bold tracking-[1px] uppercase text-foreground-secondary">
        {props.title}
      </Text>
      {props.children}
    </View>
  );
}

export function FormField({ label: _label, ...props }: FormFieldProps) {
  return <TextInput {...props} className="rounded-[18px]" />;
}
