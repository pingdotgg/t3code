import type { ComponentProps, ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { cn } from "../lib/cn";
import { AppText } from "./AppText";
import { SymbolView } from "./AppSymbol";

/** Shared geometry for Material navigation and selection lists. Group rows in one card. */
export function MaterialListRow({
  title,
  titleClassName,
  subtitle,
  leading,
  trailing,
  className,
  ...props
}: Omit<ComponentProps<typeof Pressable>, "children"> & {
  readonly title: string;
  readonly titleClassName?: string;
  readonly subtitle?: string | null;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
}) {
  const { themeVariables } = useAppearancePreferences();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[title, subtitle].filter(Boolean).join(", ")}
      android_ripple={{ color: themeVariables["--color-subtle-strong"] }}
      // Give the scroll view time to claim drags before starting the ripple.
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      {...props}
      className={cn(
        "flex-row items-center gap-4 overflow-hidden bg-card px-4 py-3",
        subtitle ? "min-h-18" : "min-h-14",
        props.disabled && "opacity-45",
        className,
      )}
    >
      {leading ? <View className="size-6 items-center justify-center">{leading}</View> : null}
      <View className="min-w-0 flex-1 gap-1">
        <AppText className={cn("text-base text-foreground", titleClassName)} numberOfLines={2}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText className="text-sm text-foreground-muted" numberOfLines={2}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {trailing !== undefined ? (
        trailing
      ) : !props.disabled ? (
        <SymbolView name="chevron.right" size={16} tintColorClassName="accent-chevron" />
      ) : null}
    </Pressable>
  );
}
