import type { ComponentProps, ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { useThemeColor } from "../lib/useThemeColor";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { themeColorWithAlpha } from "../lib/mobileTheme";
import { cn } from "../lib/cn";
import { AppText as Text } from "./AppText";
import { SymbolView } from "./AppSymbol";

const COMPOSER_TOOLBAR_GAP = 8;
const COMPOSER_TOOLBAR_FADE_WIDTH = 18;
const COMPOSER_TOOLBAR_SCROLL_EPSILON = 4;

/**
 * Quiet inline composer control used inside cards and their context rows.
 * Unlike ComposerToolbarButton, this does not draw another pill inside the
 * composer surface, so model and workspace controls read as part of the card.
 */
export function ComposerInlineControl(props: {
  readonly accessibilityHint?: string;
  readonly accessibilityLabel?: string;
  readonly disabled?: boolean;
  readonly emphasized?: boolean;
  readonly icon?: ComponentProps<typeof SymbolView>["name"];
  readonly iconNode?: ReactNode;
  readonly label: string;
  readonly maxWidth?: number;
  readonly onPress?: () => void;
  readonly selected?: boolean;
  readonly static?: boolean;
  readonly chevronDirection?: "down" | "right";
  readonly showChevron?: boolean;
}) {
  const iconColor = useThemeColor(
    props.emphasized || props.selected ? "--color-icon" : "--color-icon-muted",
  );

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityRole={props.static ? undefined : "button"}
      accessibilityState={
        props.static ? undefined : { disabled: props.disabled, selected: props.selected }
      }
      className="h-11 flex-row items-center gap-2 rounded-xl px-2 active:bg-subtle"
      disabled={props.disabled || props.static}
      onPress={props.onPress}
      style={{ maxWidth: props.maxWidth ?? 190, opacity: props.disabled ? 0.45 : 1 }}
    >
      {props.iconNode ? (
        <View className="size-4 shrink-0 items-center justify-center">{props.iconNode}</View>
      ) : props.icon ? (
        <SymbolView name={props.icon} size={16} tintColor={iconColor} type="monochrome" />
      ) : null}
      <Text
        className={cn(
          "shrink text-sm font-t3-medium",
          props.emphasized || props.selected ? "text-foreground" : "text-foreground-muted",
        )}
        numberOfLines={1}
      >
        {props.label}
      </Text>
      {props.showChevron === false ? null : (
        <SymbolView
          name={props.chevronDirection === "right" ? "chevron.right" : "chevron.down"}
          size={10}
          tintColor={iconColor}
          type="monochrome"
        />
      )}
    </Pressable>
  );
}

export function ComposerToolbarRow(props: {
  readonly children: ReactNode;
  readonly paddingBottom?: number;
  readonly paddingHorizontal?: number;
  readonly paddingTop?: number;
  readonly style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      className="flex-row items-center gap-1.5"
      style={[
        {
          paddingBottom: props.paddingBottom ?? 8,
          paddingHorizontal: props.paddingHorizontal ?? 6,
          paddingTop: props.paddingTop ?? 8,
        },
        props.style,
      ]}
    >
      {props.children}
    </View>
  );
}

export function ComposerToolbarScroller(props: {
  readonly children: ReactNode;
  readonly fadeOpaque: string;
  readonly fadeTransparent: string;
  readonly contentPaddingRight?: number;
}) {
  const [metrics, setMetrics] = useState({
    contentWidth: 0,
    offsetX: 0,
    viewportWidth: 0,
  });

  const scrollEdges = useMemo(() => {
    const maxOffset = Math.max(0, metrics.contentWidth - metrics.viewportWidth);
    return {
      showLeftFade: metrics.offsetX > COMPOSER_TOOLBAR_SCROLL_EPSILON,
      showRightFade: metrics.offsetX < maxOffset - COMPOSER_TOOLBAR_SCROLL_EPSILON,
    };
  }, [metrics]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const viewportWidth = event.nativeEvent.layout.width;
    setMetrics((current) =>
      current.viewportWidth === viewportWidth ? current : { ...current, viewportWidth },
    );
  }, []);

  const handleContentSizeChange = useCallback((contentWidth: number) => {
    setMetrics((current) =>
      current.contentWidth === contentWidth ? current : { ...current, contentWidth },
    );
  }, []);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offsetX = event.nativeEvent.contentOffset.x;
    setMetrics((current) =>
      Math.abs(current.offsetX - offsetX) < 1 ? current : { ...current, offsetX },
    );
  }, []);

  return (
    <View className="relative min-w-0 flex-1">
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        onContentSizeChange={handleContentSizeChange}
        onLayout={handleLayout}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          alignItems: "center",
          gap: COMPOSER_TOOLBAR_GAP,
          paddingLeft: 0,
          paddingRight: props.contentPaddingRight ?? 1,
        }}
      >
        {props.children}
      </ScrollView>
      {scrollEdges.showLeftFade ? (
        <View
          pointerEvents="none"
          style={{
            bottom: 0,
            experimental_backgroundImage: `linear-gradient(to right, ${props.fadeOpaque} 0%, ${props.fadeTransparent} 100%)`,
            left: 0,
            position: "absolute",
            top: 0,
            width: COMPOSER_TOOLBAR_FADE_WIDTH,
          }}
        />
      ) : null}
      {scrollEdges.showRightFade ? (
        <View
          pointerEvents="none"
          style={{
            bottom: 0,
            experimental_backgroundImage: `linear-gradient(to right, ${props.fadeTransparent} 0%, ${props.fadeOpaque} 100%)`,
            position: "absolute",
            right: 0,
            top: 0,
            width: COMPOSER_TOOLBAR_FADE_WIDTH,
          }}
        />
      ) : null}
    </View>
  );
}

export function ComposerToolbarButton(props: {
  readonly icon?: ComponentProps<typeof SymbolView>["name"];
  readonly iconNode?: ReactNode;
  readonly label?: string;
  readonly accessibilityLabel?: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly maxWidth?: number;
  readonly minWidth?: number;
  readonly onPress?: () => void;
  readonly showChevron?: boolean;
  readonly textTransform?: "none" | "uppercase";
  readonly variant?: "default" | "primary" | "danger";
  readonly className?: string;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const isDarkMode = themeAppearance === "dark";
  const iconColor = useThemeColor("--color-icon");
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const primaryFg = useThemeColor("--color-primary-foreground");
  const dangerFg = useThemeColor("--color-danger-foreground");
  const variant = props.variant ?? "default";
  const isCircle = !props.label && props.showChevron === false;
  const defaultBorderColor = useThemeColor("--color-border-subtle");
  const activeBorderColor = useThemeColor("--color-border");
  const filledBorderColor =
    variant === "danger"
      ? themeColorWithAlpha(String(dangerFg), 0.14)
      : props.disabled
        ? defaultBorderColor
        : themeColorWithAlpha(String(primaryFg), 0.18);
  const iconTintColor =
    variant === "primary"
      ? props.disabled
        ? iconSubtle
        : primaryFg
      : variant === "danger"
        ? dangerFg
        : iconColor;

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        // Default width cap lives in the class chain (not the inline style)
        // so callers can lift it with max-w-full — flex-filling pills in the
        // thread composer stretch to the row's edge. The numeric maxWidth
        // prop still wins via the inline style below.
        "h-11 max-w-[172px] flex-row items-center justify-center rounded-full active:opacity-70",
        isCircle ? "w-11" : "gap-2 px-3.5",
        variant === "primary"
          ? props.disabled
            ? "bg-subtle-strong"
            : "bg-primary"
          : variant === "danger"
            ? "bg-danger"
            : props.active
              ? "bg-subtle-strong"
              : "bg-subtle",
        props.className,
      )}
      style={({ pressed }) => [
        {
          borderColor:
            variant === "default"
              ? props.active
                ? activeBorderColor
                : defaultBorderColor
              : filledBorderColor,
          borderWidth: 1,
          maxWidth: props.maxWidth,
          minWidth: props.minWidth,
          opacity: props.disabled ? 0.55 : pressed ? 0.72 : 1,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: isDarkMode ? 3 : 2 },
          shadowOpacity: props.disabled ? 0 : isDarkMode ? 0.24 : 0.08,
          shadowRadius: isDarkMode ? 10 : 8,
        },
        props.style,
      ]}
    >
      {props.iconNode ? (
        <View className="h-4 w-4 items-center justify-center">{props.iconNode}</View>
      ) : props.icon ? (
        <SymbolView name={props.icon} size={16} tintColor={iconTintColor} type="monochrome" />
      ) : null}
      {props.label ? (
        <Text
          className={cn(
            "shrink text-center text-sm font-t3-bold",
            variant === "primary"
              ? props.disabled
                ? "text-foreground-muted"
                : "text-primary-foreground"
              : "text-foreground",
          )}
          ellipsizeMode="tail"
          numberOfLines={1}
          style={{ textTransform: props.textTransform ?? "none" }}
        >
          {props.label}
        </Text>
      ) : null}
      {props.showChevron === false ? null : (
        <SymbolView name="chevron.down" size={11} tintColor={iconTintColor} type="monochrome" />
      )}
    </Pressable>
  );
}
