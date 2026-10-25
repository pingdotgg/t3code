import type { ComponentProps, ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import Animated, { FadeIn } from "react-native-reanimated";

import { cn } from "../lib/cn";
import { AppText as Text } from "./ui/AppText";
import { SymbolView } from "./ui/AppSymbol";
import { useAndroidControlSizing } from "./ui/useAndroidControlSizing";

const COMPOSER_TOOLBAR_GAP = 8;
const COMPOSER_TOOLBAR_FADE_WIDTH = 18;
const COMPOSER_TOOLBAR_SCROLL_EPSILON = 4;
const INLINE_CONTROL_LABEL_ENTERING = FadeIn.duration(160);
export function ComposerInlineControl(props: {
  readonly size?: "regular" | "large";
  readonly accessibilityHint?: string;
  readonly accessibilityLabel?: string;
  readonly disabled?: boolean;
  readonly emphasized?: boolean;
  readonly icon?: ComponentProps<typeof SymbolView>["name"];
  readonly renderIcon?: (size: number) => ReactNode;
  readonly label: string;
  readonly suffix?: ReactNode;
  /** Show only the icon and chevron; the label still names the control for accessibility. */
  readonly iconOnly?: boolean;
  readonly maxWidth?: ViewStyle["maxWidth"];
  readonly onPress?: () => void;
  readonly selected?: boolean;
  readonly static?: boolean;
  readonly chevronDirection?: "down" | "right";
  readonly showChevron?: boolean;
}) {
  const { scale, smallIconSize } = useAndroidControlSizing();
  // Keep the picker anchored to its parent while the editor changes height.
  const animatesLabel = props.iconOnly !== undefined;
  const iconSize = props.size === "large" ? 20 : smallIconSize;
  return (
    <Animated.View
      style={{
        maxWidth: props.maxWidth ?? 190,
        overflow: animatesLabel ? "hidden" : undefined,
      }}
    >
      <Pressable
        accessibilityLabel={props.accessibilityLabel ?? props.label}
        accessibilityHint={props.accessibilityHint}
        accessibilityRole={props.static ? undefined : "button"}
        accessibilityState={
          props.static ? undefined : { disabled: props.disabled, selected: props.selected }
        }
        className="h-[44px] flex-row items-center gap-2 rounded-xl px-2 active:bg-subtle"
        disabled={props.disabled || props.static}
        onPress={props.onPress}
        style={{ opacity: props.disabled ? 0.45 : 1 }}
      >
        {props.renderIcon ? (
          <View
            className="size-4 shrink-0 items-center justify-center"
            style={{ width: iconSize, height: iconSize }}
          >
            {props.renderIcon(iconSize)}
          </View>
        ) : props.icon ? (
          <SymbolView
            name={props.icon}
            size={iconSize}
            tintColorClassName={
              props.emphasized || props.selected ? "accent-icon" : "accent-icon-muted"
            }
            type="monochrome"
          />
        ) : null}
        {props.iconOnly ? null : (
          <Animated.View
            className="shrink"
            entering={animatesLabel ? INLINE_CONTROL_LABEL_ENTERING : undefined}
          >
            <Text
              className={cn(
                props.size === "large" ? "text-base font-t3-medium" : "text-sm font-t3-medium",
                props.emphasized || props.selected ? "text-foreground" : "text-foreground-muted",
              )}
              numberOfLines={1}
            >
              {props.label}
            </Text>
          </Animated.View>
        )}
        {!props.iconOnly && props.suffix ? (
          <View className="min-w-0 shrink">{props.suffix}</View>
        ) : null}
        {props.showChevron === false ? null : (
          <SymbolView
            name={props.chevronDirection === "right" ? "chevron.right" : "chevron.down"}
            size={Math.round((props.size === "large" ? 12 : 10) * scale)}
            tintColorClassName={
              props.emphasized || props.selected ? "accent-icon" : "accent-icon-muted"
            }
            type="monochrome"
          />
        )}
      </Pressable>
    </Animated.View>
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
  readonly align?: "start" | "end";
  readonly fadeOpaque?: string;
  readonly fadeTransparent?: string;
  readonly fadeSurface?: "card" | "sheet";
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
          flexGrow: props.align === "end" ? 1 : undefined,
          justifyContent: props.align === "end" ? "flex-end" : undefined,
          gap: COMPOSER_TOOLBAR_GAP,
          paddingLeft: 0,
          paddingRight: props.contentPaddingRight ?? 1,
        }}
      >
        {props.children}
      </ScrollView>
      {scrollEdges.showLeftFade ? (
        <View
          className={cn(
            "absolute inset-y-0 left-0",
            props.fadeOpaque === undefined && "bg-linear-to-r to-transparent",
            props.fadeOpaque === undefined &&
              (props.fadeSurface === "sheet" ? "from-sheet" : "from-card"),
          )}
          pointerEvents="none"
          style={{
            width: COMPOSER_TOOLBAR_FADE_WIDTH,
            experimental_backgroundImage:
              props.fadeOpaque === undefined
                ? undefined
                : `linear-gradient(to right, ${props.fadeOpaque} 0%, ${props.fadeTransparent ?? "transparent"} 100%)`,
          }}
        />
      ) : null}
      {scrollEdges.showRightFade ? (
        <View
          className={cn(
            "absolute inset-y-0 right-0",
            props.fadeOpaque === undefined && "bg-linear-to-r from-transparent",
            props.fadeOpaque === undefined &&
              (props.fadeSurface === "sheet" ? "to-sheet" : "to-card"),
          )}
          pointerEvents="none"
          style={{
            width: COMPOSER_TOOLBAR_FADE_WIDTH,
            experimental_backgroundImage:
              props.fadeOpaque === undefined
                ? undefined
                : `linear-gradient(to right, ${props.fadeTransparent ?? "transparent"} 0%, ${props.fadeOpaque} 100%)`,
          }}
        />
      ) : null}
    </View>
  );
}

export function ComposerActionButton(props: {
  readonly size?: "regular" | "large";
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly onPress: () => void;
  readonly variant?: "primary" | "danger";
  // Menu injects onLongPress on Android and onTouchStart/onPress on iOS.
  readonly onLongPress?: PressableProps["onLongPress"];
  readonly onTouchStart?: PressableProps["onTouchStart"];
}) {
  const { scale, smallIconSize } = useAndroidControlSizing();
  const circleSize = Math.round((props.size === "large" ? 44 : 30) * scale);
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center active:opacity-70"
      style={props.size === "large" ? { width: 62 } : undefined}
      disabled={props.disabled}
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      onTouchStart={props.onTouchStart}
    >
      <View
        style={{ width: circleSize, height: circleSize }}
        className={cn(
          "items-center justify-center rounded-full",
          props.variant === "danger"
            ? "bg-danger"
            : props.disabled
              ? "bg-primary/15"
              : "bg-primary",
        )}
      >
        <SymbolView
          name={props.icon}
          size={props.size === "large" ? Math.round(20 * scale) : smallIconSize}
          weight="semibold"
          tintColorClassName={
            props.variant === "danger" ? "accent-danger-foreground" : "accent-primary-foreground"
          }
          type="monochrome"
        />
      </View>
    </Pressable>
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
  const variant = props.variant ?? "default";
  const isCircle = !props.label && props.showChevron === false;
  const iconTintClassName =
    variant === "primary"
      ? props.disabled
        ? "accent-icon-subtle"
        : "accent-primary-foreground"
      : variant === "danger"
        ? "accent-danger-foreground"
        : "accent-icon";

  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "h-11 max-w-[172px] flex-row items-center justify-center rounded-full border active:opacity-70",
        variant === "primary" && "shadow-lg shadow-adaptive-black-a10-a25 disabled:shadow-none",
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
        variant === "default"
          ? props.active
            ? "border-border"
            : "border-border-subtle"
          : variant === "danger"
            ? "border-danger-border"
            : props.disabled
              ? "border-border-subtle"
              : "border-primary-foreground/20",
        props.className,
      )}
      style={({ pressed }) => [
        {
          maxWidth: props.maxWidth,
          minWidth: props.minWidth,
          opacity: props.disabled ? 0.55 : pressed ? 0.72 : 1,
        },
        props.style,
      ]}
    >
      {props.iconNode ? (
        <View className="h-4 w-4 items-center justify-center">{props.iconNode}</View>
      ) : props.icon ? (
        <SymbolView
          name={props.icon}
          size={16}
          tintColorClassName={iconTintClassName}
          type="monochrome"
        />
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
        <SymbolView
          name="chevron.down"
          size={11}
          tintColorClassName={iconTintClassName}
          type="monochrome"
        />
      )}
    </Pressable>
  );
}
