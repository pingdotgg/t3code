import type { ComponentProps } from "react";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

/** Primary actions in the cards that replace the thread composer. */
export function RequestActionButton({
  label,
  tone = "primary",
  size = "default",
  disabled,
  ...props
}: Omit<ComponentProps<typeof Pressable>, "children" | "className" | "style"> & {
  label: string;
  tone?: "primary" | "secondary" | "danger";
  size?: "default" | "large";
}) {
  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      accessibilityState={{ ...props.accessibilityState, disabled: Boolean(disabled) }}
      disabled={disabled}
      className={cn(
        "items-center justify-center active:opacity-70 disabled:opacity-50",
        size === "large" ? "rounded-2xl px-4 py-3.5" : "rounded-[14px] px-3.5 py-3",
        tone === "primary" ? "bg-primary" : tone === "danger" ? "bg-danger" : "bg-subtle-strong",
      )}
    >
      <Text
        className={cn(
          "text-sm",
          tone === "primary"
            ? "font-t3-extrabold text-primary-foreground"
            : tone === "danger"
              ? "font-t3-bold text-danger-foreground"
              : "font-t3-bold text-foreground",
        )}
      >
        {label}
      </Text>
    </Pressable>
  );
}
