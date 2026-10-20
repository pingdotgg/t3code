import { MaskedView } from "@expo/ui/community/masked-view";
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useId, useState } from "react";
import { AccessibilityInfo, AppState, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { AppText as Text } from "../../../components/ui/AppText";
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";

/** Glimmer throughout generation; pause while hidden, backgrounded, or motion is reduced. */
export function GuideGeneratingHeading({
  rewriting = false,
  visible = true,
}: {
  readonly rewriting?: boolean;
  readonly visible?: boolean;
}) {
  const label = rewriting ? "Rewriting guide…" : "Generating guide…";
  const { themeVariables: colors } = useAppearancePreferences();
  const focused = useIsFocused();
  const [active, setActive] = useState(AppState.currentState === "active");
  const [reduceMotion, setReduceMotion] = useState(true);
  const [width, setWidth] = useState(0);
  const progress = useSharedValue(0);
  const gradientId = `guide-glimmer-${useId().replaceAll(":", "")}`;
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setReduceMotion(value);
    });
    const motion = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    const app = AppState.addEventListener("change", (value) => setActive(value === "active"));
    return () => {
      mounted = false;
      motion.remove();
      app.remove();
    };
  }, []);
  useEffect(() => {
    cancelAnimation(progress);
    progress.set(0);
    if (reduceMotion || !active || !focused || !visible || !width) return;
    progress.set(
      withRepeat(withTiming(1, { duration: 2400, easing: Easing.inOut(Easing.ease) }), -1),
    );
    return () => cancelAnimation(progress);
  }, [active, focused, progress, reduceMotion, visible, width]);
  const animated = useAnimatedStyle(() => ({
    transform: [{ translateX: -width + progress.get() * width * 2 }],
  }));
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityState={{ busy: true }}
      className="self-start"
    >
      <Text
        className="text-base font-t3-semibold text-foreground-muted"
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        {label}
      </Text>
      {!reduceMotion && active && focused && visible && width > 0 ? (
        <MaskedView
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ position: "absolute", inset: 0 }}
          maskElement={
            <Text style={{ color: "black" }} className="text-base font-t3-semibold">
              {label}
            </Text>
          }
        >
          <Animated.View style={[{ width, height: "100%" }, animated]}>
            <Svg width="100%" height="100%">
              <Defs>
                <LinearGradient id={gradientId} x1="0%" x2="100%" y1="0%" y2="0%">
                  <Stop offset="0" stopColor={colors["--color-foreground"]} stopOpacity={0} />
                  <Stop offset="0.5" stopColor={colors["--color-foreground"]} />
                  <Stop offset="1" stopColor={colors["--color-foreground"]} stopOpacity={0} />
                </LinearGradient>
              </Defs>
              <Rect width="100%" height="100%" fill={`url(#${gradientId})`} />
            </Svg>
          </Animated.View>
        </MaskedView>
      ) : null}
    </View>
  );
}
