import {
  Platform,
  Text as RNText,
  TextInput as RNTextInput,
  type TextInputInstance,
  type TextInputProps as RNTextInputProps,
  type TextProps as RNTextProps,
} from "react-native";

import { MOBILE_TEXT_CLASSES } from "../../lib/typography";

import { cn } from "../../lib/cn";
import { directionalText } from "../../lib/directionalText";
import { textDirection } from "@t3tools/shared/textDirection";

export type AppTextProps = RNTextProps & {
  readonly className?: string;
  readonly textRole?: keyof typeof MOBILE_TEXT_CLASSES;
};

export function AppText({ className, textRole, style, children, ...props }: AppTextProps) {
  // Plain-string text takes its own reading direction, so Hebrew and Arabic read right to left anywhere.
  const direction = typeof children === "string" ? textDirection(children) : undefined;
  return (
    <RNText
      className={cn(
        "font-sans text-foreground",
        textRole && MOBILE_TEXT_CLASSES[textRole],
        className,
      )}
      selectionColorClassName={Platform.OS === "android" ? "accent-focus/32" : undefined}
      style={direction ? [{ writingDirection: direction }, style] : style}
      {...props}
    >
      {typeof children === "string" ? directionalText(children) : children}
    </RNText>
  );
}

export type AppTextInputProps = Omit<RNTextInputProps, "placeholderTextColor"> & {
  readonly className?: string;
  readonly ref?: React.Ref<TextInputInstance>;
};

export function AppTextInput({ className, ref, ...props }: AppTextInputProps) {
  return (
    <RNTextInput
      ref={ref}
      className={cn(
        "min-h-13.5 rounded-2xl border border-input-border bg-input px-3.5 py-3 font-sans text-base text-foreground",
        className,
      )}
      placeholderTextColorClassName="accent-placeholder"
      selectionColorClassName={"accent-focus/32"}
      cursorColorClassName={"accent-focus"}
      selectionHandleColorClassName={Platform.OS === "android" ? "accent-focus" : undefined}
      {...props}
    />
  );
}
