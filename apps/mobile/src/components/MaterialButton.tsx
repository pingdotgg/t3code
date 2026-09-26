import { Pressable } from "react-native";
import { AppText } from "./AppText";
import { cn } from "../lib/cn";

export interface MaterialButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly tone?: "primary" | "secondary" | "danger" | "text";
  readonly fullWidth?: boolean;
}

const TONE_CLASS_NAMES = {
  primary: ["bg-primary", "text-primary-foreground"],
  secondary: ["bg-secondary", "text-secondary-foreground"],
  danger: ["bg-danger", "text-danger-foreground"],
  text: ["bg-transparent", "text-primary-text"],
} as const;

export function MaterialButton(props: MaterialButtonProps) {
  const [containerClassName, labelClassName] = TONE_CLASS_NAMES[props.tone ?? "secondary"];
  const disabled = Boolean(props.disabled || props.loading);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-12 justify-center rounded-full px-6 active:opacity-70",
        props.fullWidth ? "w-full" : "self-start",
        disabled ? "bg-subtle-strong" : containerClassName,
      )}
    >
      <AppText
        className={cn(
          "text-center font-t3-medium",
          disabled ? "text-foreground-muted" : labelClassName,
        )}
      >
        {props.label}
      </AppText>
    </Pressable>
  );
}
