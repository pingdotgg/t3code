import {
  Text as RNText,
  TextInput as RNTextInput,
  type TextInputProps as RNTextInputProps,
  type TextProps as RNTextProps,
} from "react-native";
import { useThemeColor } from "../lib/useThemeColor";

import { cn } from "../lib/cn";

export type AppTextProps = RNTextProps & { readonly className?: string };

/**
 * Thin wrapper around RN Text with default font-family and foreground color.
 * Uses Uniwind className — no manual style parsing.
 */
export function AppText({ className, ...props }: AppTextProps) {
  return <RNText className={cn("font-sans text-foreground", className)} {...props} />;
}

export type AppTextInputProps = RNTextInputProps & { readonly className?: string };

/**
 * Thin wrapper around RN TextInput with default input styling.
 * Uses Uniwind className — no manual style parsing.
 */
export function AppTextInput({ className, placeholderTextColor, ...props }: AppTextInputProps) {
  const placeholderColor = useThemeColor("--color-placeholder");

  return (
    <RNTextInput
      className={cn(
        "min-h-[54px] rounded-2xl border border-input-border bg-input px-3.5 py-3 font-sans text-[15px] text-foreground",
        className,
      )}
      placeholderTextColor={placeholderTextColor ?? placeholderColor}
      {...props}
    />
  );
}
