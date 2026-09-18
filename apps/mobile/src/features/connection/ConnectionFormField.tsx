import { View } from "react-native";

import { AppText, AppTextInput, type AppTextInputProps } from "../../components/AppText";
import { cn } from "../../lib/cn";

type ConnectionFormFieldProps = Omit<AppTextInputProps, "className"> & {
  readonly label: string;
  readonly className?: string;
};

/** Labeled connection input with a native wrapper retained inside form sheets. */
export function ConnectionFormField({ label, className, ...inputProps }: ConnectionFormFieldProps) {
  return (
    <View collapsable={false} className={cn("gap-1.5", className)}>
      <AppText className="text-2xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted">
        {label}
      </AppText>
      <AppTextInput
        accessibilityLabel={label}
        {...inputProps}
        className="rounded-[14px] px-4 py-3.5"
      />
    </View>
  );
}
