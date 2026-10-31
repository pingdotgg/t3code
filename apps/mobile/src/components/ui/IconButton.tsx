import type { IconButtonProps } from "./IconButton.types";
import { cn } from "../../lib/cn";
import { Pressable } from "react-native";

import { SymbolView } from "./AppSymbol";

const VARIANT_CLASS_NAMES = {
  standard: ["", "accent-foreground"],
  primary: ["rounded-full bg-primary", "accent-primary-foreground"],
  danger: ["rounded-full bg-danger", "accent-danger-foreground"],
  tonal: ["rounded-full bg-secondary", "accent-secondary-foreground"],
} as const;

export function IconButton(props: IconButtonProps) {
  const variant = props.variant ?? "standard";
  const [containerClassName, iconTintClassName] = VARIANT_CLASS_NAMES[variant];
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(props.disabled), selected: props.selected }}
      className={cn(
        "size-12 items-center justify-center",
        props.disabled && variant !== "standard"
          ? "rounded-full bg-subtle-strong"
          : containerClassName,
      )}
    >
      <SymbolView
        name={props.icon}
        size={24}
        tintColorClassName={
          props.disabled
            ? "accent-icon-subtle"
            : variant === "standard"
              ? (props.tintColorClassName ?? iconTintClassName)
              : iconTintClassName
        }
      />
    </Pressable>
  );
}
