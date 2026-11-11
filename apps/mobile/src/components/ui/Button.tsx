import { SymbolView, type AppSymbolName } from "./AppSymbol";
import { Pressable } from "react-native";
import { AppActivityIndicator } from "./AppActivityIndicator";
import { AppText } from "./AppText";
import { cn } from "../../lib/cn";

export interface ButtonProps {
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly icon?: AppSymbolName;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly accessibilityHint?: string;
  readonly loading?: boolean;
  readonly tone?: "primary" | "secondary" | "danger" | "text" | "contrast";
  readonly fullWidth?: boolean;
  readonly size?: "default" | "compact";
}

const TONE_CLASS_NAMES = {
  contrast: ["bg-foreground", "text-screen"],
  primary: ["bg-primary", "text-primary-foreground"],
  secondary: ["bg-secondary", "text-secondary-foreground"],
  danger: ["bg-danger", "text-danger-foreground"],
  text: ["bg-transparent", "text-primary-text"],
} as const;

export function Button(props: ButtonProps) {
  const [containerClassName, labelClassName] = TONE_CLASS_NAMES[props.tone ?? "secondary"];
  const disabled = Boolean(props.disabled || props.loading);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled, busy: Boolean(props.loading) }}
      disabled={disabled}
      onPress={props.onPress}
      className={cn(
        "flex-row items-center justify-center gap-2 rounded-full active:opacity-70",
        props.size === "compact" ? "min-h-10 px-5" : "min-h-12 px-6",
        props.fullWidth ? "w-full" : "self-start",
        disabled ? "bg-subtle-strong" : containerClassName,
      )}
    >
      {props.loading ? (
        <AppActivityIndicator colorClassName="accent-foreground-muted" />
      ) : props.icon ? (
        <SymbolView
          name={props.icon}
          size={18}
          tintColorClassName={
            disabled ? "accent-foreground-muted" : labelClassName.replace("text-", "accent-")
          }
        />
      ) : null}
      <AppText
        className={cn(
          "min-w-0 shrink text-center font-t3-medium",
          disabled ? "text-foreground-muted" : labelClassName,
        )}
      >
        {props.label}
      </AppText>
    </Pressable>
  );
}
