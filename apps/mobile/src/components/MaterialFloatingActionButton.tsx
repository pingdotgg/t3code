import type { ComponentProps } from "react";
import { Pressable } from "react-native";
import type { MaterialFloatingActionButton as AndroidMaterialFloatingActionButton } from "./MaterialFloatingActionButton.android";
import { AppText } from "./AppText";
import { SymbolView } from "./AppSymbol";
import { cn } from "../lib/cn";

export function MaterialFloatingActionButton(
  props: ComponentProps<typeof AndroidMaterialFloatingActionButton>,
) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      className={cn(
        "min-h-14 min-w-14 flex-row items-center justify-center gap-2 rounded-2xl px-4",
        props.tone === "primary" ? "bg-primary" : "bg-thread-selected",
        props.className,
      )}
      style={props.style}
    >
      <SymbolView
        name={props.icon}
        size={24}
        tintColorClassName={
          props.tone === "primary"
            ? "accent-primary-foreground"
            : "accent-thread-selected-foreground"
        }
      />
      {props.variant === "extended" && props.expanded !== false ? (
        <AppText
          className={cn(
            "text-sm",
            props.tone === "primary"
              ? "text-primary-foreground"
              : "text-thread-selected-foreground",
          )}
        >
          {props.label}
        </AppText>
      ) : null}
    </Pressable>
  );
}
