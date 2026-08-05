import type { ComponentProps, ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  View,
  useColorScheme,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Svg, { Circle } from "react-native-svg";

import { useThemeColor } from "../lib/useThemeColor";
import { cn } from "../lib/cn";
import { AppText as Text } from "./AppText";
import { SymbolView } from "./AppSymbol";

export const COMPOSER_TOOLBAR_CONTROL_HEIGHT = 44;
export const COMPOSER_TOOLBAR_GAP = 8;
export const COMPOSER_TOOLBAR_FADE_WIDTH = 18;
const COMPOSER_TOOLBAR_SCROLL_EPSILON = 4;

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
  readonly size?: "default" | "compact";
  readonly textTransform?: "none" | "uppercase";
  readonly variant?: "default" | "ghost" | "primary" | "danger";
  readonly className?: string;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const isDarkMode = useColorScheme() === "dark";
  const iconColor = useThemeColor("--color-icon");
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const primaryFg = useThemeColor("--color-primary-foreground");
  const dangerFg = useThemeColor("--color-danger-foreground");
  const variant = props.variant ?? "default";
  const isCompact = props.size === "compact";
  const isCircle = !props.label && props.showChevron === false;
  const defaultBorderColor = isDarkMode ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)";
  const activeBorderColor = isDarkMode ? "rgba(255,255,255,0.13)" : "rgba(0,0,0,0.1)";
  const filledBorderColor =
    variant === "danger"
      ? "rgba(255,255,255,0.14)"
      : props.disabled
        ? defaultBorderColor
        : "rgba(255,255,255,0.18)";
  const iconTintColor =
    variant === "primary"
      ? props.disabled
        ? iconSubtle
        : primaryFg
      : variant === "danger"
        ? dangerFg
        : variant === "ghost"
          ? iconSubtle
          : iconColor;

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityRole="button"
      disabled={props.disabled}
      hitSlop={isCompact ? 4 : undefined}
      onPress={props.onPress}
      className={cn(
        // Default width cap lives in the class chain (not the inline style)
        // so callers can lift it with max-w-full — flex-filling pills in the
        // thread composer stretch to the row's edge. The numeric maxWidth
        // prop still wins via the inline style below.
        "max-w-[172px] flex-row items-center justify-center rounded-full active:opacity-70",
        isCompact ? "h-9" : "h-11",
        isCircle ? (isCompact ? "w-9" : "w-11") : isCompact ? "gap-1.5 px-1.5" : "gap-2 px-3.5",
        variant === "primary"
          ? props.disabled
            ? "bg-subtle-strong"
            : "bg-primary"
          : variant === "danger"
            ? "bg-danger"
            : variant === "ghost"
              ? "bg-transparent"
              : props.active
                ? "bg-subtle-strong"
                : "bg-subtle",
        props.className,
      )}
      style={({ pressed }) => [
        {
          borderColor:
            variant === "ghost"
              ? "transparent"
              : variant === "default"
                ? props.active
                  ? activeBorderColor
                  : defaultBorderColor
                : filledBorderColor,
          borderWidth: variant === "ghost" ? 0 : 1,
          maxWidth: props.maxWidth,
          minWidth: props.minWidth,
          opacity: props.disabled ? 0.55 : pressed ? 0.72 : 1,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: isDarkMode ? 3 : 2 },
          shadowOpacity: props.disabled || variant === "ghost" ? 0 : isDarkMode ? 0.24 : 0.08,
          shadowRadius: isDarkMode ? 10 : 8,
        },
        props.style,
      ]}
    >
      {props.iconNode ? (
        <View
          className={cn("items-center justify-center", isCompact ? "h-4 w-4" : "h-[18px] w-[18px]")}
        >
          {props.iconNode}
        </View>
      ) : props.icon ? (
        <SymbolView
          name={props.icon}
          size={isCompact ? 16 : 18}
          tintColor={iconTintColor}
          type="monochrome"
        />
      ) : null}
      {props.label ? (
        <Text
          className={cn(
            "shrink text-center font-t3-bold",
            isCompact ? "text-sm" : "text-base",
            variant === "primary"
              ? props.disabled
                ? "text-foreground-muted"
                : "text-primary-foreground"
              : variant === "ghost"
                ? "text-foreground-muted"
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

/**
 * The mobile composer keeps the web context-window affordance in the footer.
 * Usage is optional because the mobile thread shell does not always include a
 * context snapshot; in that case the quiet track still reserves the control.
 */
export function ComposerContextRing(props: { readonly usedPercentage?: number | null }) {
  const trackColor = useThemeColor("--color-border");
  const progressColor = useThemeColor("--color-icon-subtle");
  const normalizedPercentage = Math.max(0, Math.min(100, props.usedPercentage ?? 0));
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;

  return (
    <View
      accessible
      accessibilityLabel={
        props.usedPercentage == null
          ? "Context window"
          : `Context window ${Math.round(normalizedPercentage)} percent used`
      }
      className="h-11 w-9 items-center justify-center"
    >
      <Svg width={20} height={20} viewBox="0 0 18 18">
        <Circle cx={9} cy={9} r={radius} fill="none" stroke={trackColor} strokeWidth={2.5} />
        {normalizedPercentage > 0 ? (
          <Circle
            cx={9}
            cy={9}
            r={radius}
            fill="none"
            rotation={-90}
            origin="9, 9"
            stroke={progressColor}
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            strokeWidth={2.5}
          />
        ) : null}
      </Svg>
    </View>
  );
}

export const ComposerToolbarTrigger = ComposerToolbarButton;
