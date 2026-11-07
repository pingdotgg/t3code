import type { ComponentProps } from "react";
import { Pressable } from "react-native";

import { cn } from "../lib/cn";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../native/native-glass";
import { AppText } from "./ui/AppText";
import { SymbolView } from "./ui/AppSymbol";
import { GlassSurface } from "./ui/GlassSurface";
import { NewThreadButton as SolidNewThreadButton } from "./NewThreadButton.shared";

export function NewThreadButton(props: ComponentProps<typeof SolidNewThreadButton>) {
  if (!NATIVE_LIQUID_GLASS_SUPPORTED) {
    return <SolidNewThreadButton {...props} />;
  }

  const label = props.label ?? "New thread";
  const icon = props.icon ?? "square.and.pencil";
  const showLabel = props.extended === true && props.expanded !== false;
  const height = props.extended ? 48 : 56;

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={props.onPress}
      className={cn("active:opacity-85", props.className)}
      style={props.style}
    >
      <GlassSurface
        isInteractive
        style={{
          height,
          borderRadius: height / 2,
          alignSelf: "center",
        }}
        className={cn(
          "items-center justify-center",
          props.extended ? "flex-row gap-2 px-6" : "w-14",
        )}
      >
        <SymbolView
          name={icon}
          size={props.extended ? 20 : 23}
          tintColorClassName="accent-primary"
          type="monochrome"
        />
        {showLabel ? (
          <AppText className="text-[16px] font-t3-semibold text-primary">{label}</AppText>
        ) : null}
      </GlassSurface>
    </Pressable>
  );
}
