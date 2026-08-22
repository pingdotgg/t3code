import * as Haptics from "expo-haptics";
import { isLiquidGlassSupported, LiquidGlassView } from "@callstack/liquid-glass";
import { SymbolView } from "../../components/AppSymbol";
import { useCallback, useEffect, useRef } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { APP_BAR_HEIGHT } from "../../lib/layoutMetrics";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useThemeColor } from "../../lib/useThemeColor";
import type { GitActionProgress } from "../../state/use-vcs-action-state";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

const OVERLAY_LAYOUT_TRANSITION = LinearTransition.duration(220);
const OVERLAY_TOP_GAP = 8;
const AnimatedLiquidGlassView = Animated.createAnimatedComponent(LiquidGlassView);

export function GitActionProgressOverlay(props: {
  readonly progress: GitActionProgress;
  readonly onDismiss: () => void;
}) {
  const { progress, onDismiss } = props;
  const insets = useSafeAreaInsets();
  const prevPhaseRef = useRef(progress.phase);

  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = progress.phase;

    if (prev === "running" && progress.phase === "success") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (prev === "running" && progress.phase === "error") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [progress.phase]);

  const handlePress = useCallback(() => {
    if (progress.prUrl) {
      void tryOpenExternalUrl(progress.prUrl, "pull-request");
      return;
    }
    if (progress.phase === "success" || progress.phase === "error") {
      onDismiss();
    }
  }, [onDismiss, progress.phase, progress.prUrl]);

  if (progress.phase === "idle") {
    return null;
  }

  return (
    <Animated.View
      entering={isLiquidGlassSupported ? undefined : FadeIn.duration(200)}
      exiting={FadeOut.duration(150)}
      className="absolute inset-x-3 z-[100]"
      style={{ top: insets.top + APP_BAR_HEIGHT + OVERLAY_TOP_GAP }}
      pointerEvents="box-none"
    >
      <Pressable onPress={handlePress}>
        <OverlayContent progress={progress} />
      </Pressable>
    </Animated.View>
  );
}

function OverlayContent(props: { readonly progress: GitActionProgress }) {
  const { progress } = props;
  const { materialYouStyleLayoutActive, themeAppearance } = useAppearancePreferences();
  const iconColor = useThemeColor("--color-icon");
  const primaryColor = useThemeColor("--color-primary");
  const primaryForegroundColor = useThemeColor("--color-primary-foreground");
  const dangerColor = useThemeColor("--color-danger");
  const dangerForegroundColor = useThemeColor("--color-danger-foreground");
  const glassBorder = useThemeColor("--color-header-border");
  const glassTint = useThemeColor("--color-glass-tint");
  const isDarkMode = themeAppearance === "dark";
  const content = (
    <>
      <OverlayIcon
        phase={progress.phase}
        iconColor={iconColor}
        materialYouStyleLayoutActive={materialYouStyleLayoutActive}
        primaryColor={primaryColor}
        primaryForegroundColor={primaryForegroundColor}
        dangerColor={dangerColor}
        dangerForegroundColor={dangerForegroundColor}
      />

      <View className="flex-1 gap-0.5">
        {progress.label ? (
          <Text className="text-sm font-t3-bold text-foreground" numberOfLines={1}>
            {progress.label}
          </Text>
        ) : null}
        {progress.description ? (
          <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
            {progress.description}
          </Text>
        ) : null}
      </View>

      {progress.prUrl ? (
        <SymbolView name="arrow.up.right" size={13} tintColor={iconColor} type="monochrome" />
      ) : null}
    </>
  );

  if (isLiquidGlassSupported) {
    return (
      <Animated.View
        layout={OVERLAY_LAYOUT_TRANSITION}
        style={{
          backgroundColor: glassTint,
          borderColor: glassBorder,
          borderCurve: "continuous",
          borderRadius: 26,
          borderWidth: StyleSheet.hairlineWidth,
          overflow: "hidden",
        }}
      >
        <AnimatedLiquidGlassView
          colorScheme={isDarkMode ? "dark" : "light"}
          effect="regular"
          interactive
          layout={OVERLAY_LAYOUT_TRANSITION}
          style={{
            borderCurve: "continuous",
            borderRadius: 26,
            overflow: "hidden",
          }}
        >
          <Animated.View
            entering={FadeIn.delay(60).duration(140)}
            className="flex-row items-center gap-2.5 px-3.5 py-3"
          >
            {content}
          </Animated.View>
        </AnimatedLiquidGlassView>
      </Animated.View>
    );
  }

  const bgClass =
    progress.phase === "error"
      ? materialYouStyleLayoutActive
        ? "border-danger-border bg-danger"
        : "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/80"
      : materialYouStyleLayoutActive
        ? "border-header-border bg-header"
        : "border-border bg-card";
  const shadowClass = materialYouStyleLayoutActive ? "" : "shadow-lg shadow-black/10";

  return (
    <Animated.View
      layout={OVERLAY_LAYOUT_TRANSITION}
      className={`flex-row items-center gap-2.5 rounded-[26px] border border-continuous px-3.5 py-3 ${shadowClass} ${bgClass}`}
    >
      {content}
    </Animated.View>
  );
}

function OverlayIcon(props: {
  readonly phase: GitActionProgress["phase"];
  readonly iconColor: ReturnType<typeof useThemeColor>;
  readonly materialYouStyleLayoutActive: boolean;
  readonly primaryColor: ReturnType<typeof useThemeColor>;
  readonly primaryForegroundColor: ReturnType<typeof useThemeColor>;
  readonly dangerColor: ReturnType<typeof useThemeColor>;
  readonly dangerForegroundColor: ReturnType<typeof useThemeColor>;
}) {
  switch (props.phase) {
    case "running":
      return <ActivityIndicator size="small" />;
    case "success":
      return (
        <View
          className="h-6 w-6 items-center justify-center rounded-full"
          style={{
            backgroundColor: props.materialYouStyleLayoutActive ? props.primaryColor : "#22c55e",
          }}
        >
          <SymbolView
            name="checkmark"
            size={12}
            tintColor={props.materialYouStyleLayoutActive ? props.primaryForegroundColor : "white"}
            type="monochrome"
          />
        </View>
      );
    case "error":
      return (
        <View
          className="h-6 w-6 items-center justify-center rounded-full"
          style={{
            backgroundColor: props.materialYouStyleLayoutActive ? props.dangerColor : "#ef4444",
          }}
        >
          <SymbolView
            name="exclamationmark.triangle"
            size={12}
            tintColor={props.materialYouStyleLayoutActive ? props.dangerForegroundColor : "white"}
            type="monochrome"
          />
        </View>
      );
    default:
      return null;
  }
}
