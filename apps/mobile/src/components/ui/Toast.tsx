import { MOBILE_MOTION, MOBILE_SHAPE } from "../../lib/designTokens";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { AccessibilityInfo, Platform, StyleSheet, View, useWindowDimensions } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  FadeOut,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type EntryAnimationsValues,
} from "react-native-reanimated";

import { AppText } from "./AppText";
import { Button } from "./Button";
import { GlassSurface } from "./GlassSurface";
import { useControlTheme } from "./useControlTheme";
import { IconButton } from "./IconButton";
import { AppActivityIndicator } from "./AppActivityIndicator";
import { SymbolView } from "./AppSymbol";

export type ToastProps = {
  readonly message: string;
  readonly description?: string;
  readonly singleLine?: boolean;
  readonly tone?: "default" | "success" | "danger";
  readonly busy?: boolean;
  readonly action?: { readonly label: string; readonly onPress: () => void };
} & (
  | { readonly dismissMode: "swipe"; readonly onDismiss: () => void }
  | { readonly dismissMode?: "button"; readonly onDismiss?: () => void }
);

export function Toast(props: ToastProps) {
  return props.dismissMode === "swipe" ? (
    <SwipeableToast {...props} />
  ) : (
    <ToastContent {...props} />
  );
}

function ToastContent(props: ToastProps & { readonly glassReady?: boolean }) {
  const { fontScale } = useWindowDimensions();
  const { colorScheme } = useControlTheme();
  const borderRadius = Platform.OS === "ios" ? 31 : MOBILE_SHAPE.toast;
  // Explicit single-line notices reserve the action's width and truncate the text.
  const inlineAction = props.singleLine || (!props.description && fontScale < 1.5);
  const message =
    props.singleLine && props.description
      ? `${props.message}: ${props.description}`
      : props.message;
  const action = props.action ? (
    <Button label={props.action.label} onPress={props.action.onPress} />
  ) : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- announces the toast message to VoiceOver through AccessibilityInfo
  useEffect(() => {
    if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(props.message);
  }, [props.message]);
  const surface = (
    <GlassSurface
      key={props.glassReady === false ? "entering" : "settled"}
      chrome={Platform.OS === "ios" && colorScheme === "dark" ? "none" : undefined}
      tintColor={Platform.OS === "ios" ? null : undefined}
      className={Platform.OS === "ios" ? "bg-transparent p-3" : "p-3"}
      style={{ borderRadius }}
    >
      <View className="flex-row items-center gap-3">
        {props.busy ? (
          <AppActivityIndicator />
        ) : (
          <SymbolView
            name={props.tone === "danger" ? "exclamationmark.triangle" : "checkmark.circle"}
            size={20}
            tintColorClassName={
              props.tone === "danger" ? "accent-danger-foreground" : "accent-icon"
            }
          />
        )}
        <View className="min-w-0 flex-1" accessibilityLiveRegion="polite">
          <AppText
            textRole="footnote"
            className="font-t3-semibold"
            numberOfLines={props.singleLine ? 1 : undefined}
            accessibilityLabel={props.singleLine ? message : undefined}
          >
            {message}
          </AppText>
          {props.description && !props.singleLine ? (
            <AppText textRole="label" className="text-foreground-muted">
              {props.description}
            </AppText>
          ) : null}
        </View>
        {inlineAction && action ? <View className="self-center">{action}</View> : null}
        {props.onDismiss && props.dismissMode !== "swipe" ? (
          <IconButton accessibilityLabel="Dismiss message" icon="xmark" onPress={props.onDismiss} />
        ) : null}
      </View>
      {action && !inlineAction ? <View className="mt-2 self-end">{action}</View> : null}
    </GlassSurface>
  );
  return Platform.OS === "ios" ? (
    <View
      style={{
        borderRadius,
        boxShadow: [
          {
            offsetX: 0,
            offsetY: 0,
            blurRadius: 8,
            color: colorScheme === "dark" ? "rgba(0, 0, 0, 0.22)" : "rgba(0, 0, 0, 0.08)",
          },
        ],
      }}
    >
      {surface}
    </View>
  ) : (
    surface
  );
}

const SWIPE_TIMING = { duration: 160, reduceMotion: ReduceMotion.System };
const ENTER_TIMING = {
  duration: MOBILE_MOTION.enter,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
};
const TOAST_EXITING = FadeOut.duration(MOBILE_MOTION.exit).reduceMotion(ReduceMotion.System);
function SwipeableToast(props: ToastProps & { readonly onDismiss: () => void }) {
  const [glassReady, setGlassReady] = useState(Platform.OS !== "ios");
  const finishEntering = useCallback(() => setGlassReady(true), []);
  // UIKit can skip glass on a moving host; remount the surface after entry so its blur installs.
  const toastEntering = useMemo(
    () => (values: EntryAnimationsValues) => {
      "worklet";
      return {
        initialValues: { originY: values.targetOriginY + values.targetHeight + 12 },
        animations: { originY: withTiming(values.targetOriginY, ENTER_TIMING) },
        callback: (finished: boolean) => {
          if (finished) runOnJS(finishEntering)();
        },
      };
    },
    [finishEntering],
  );
  const { onDismiss } = props;
  const translation = useSharedValue(0);
  const width = useSharedValue(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the Reanimated swipe translation animation on unmount
  useLayoutEffect(
    () => () => {
      cancelAnimation(translation);
    },
    [translation],
  );
  const gesture = usePanGesture({
    activeOffsetX: [-10, 10],
    failOffsetY: [-12, 12],
    onUpdate: (event) => {
      translation.set(event.translationX);
    },
    onDeactivate: (event) => {
      if (
        !event.canceled &&
        (Math.abs(event.translationX) > width.value * 0.25 ||
          (Math.abs(event.velocityX) > 800 && event.translationX * event.velocityX > 0))
      ) {
        const direction = Math.sign(event.translationX || event.velocityX);
        translation.set(
          withTiming(direction * (width.value + 24), SWIPE_TIMING, (finished) => {
            if (finished) runOnJS(onDismiss)();
          }),
        );
      } else {
        translation.set(withTiming(0, SWIPE_TIMING));
      }
    },
  });
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translation.value }],
  }));
  return (
    <Animated.View
      className={Platform.OS === "android" ? "overflow-hidden" : undefined}
      pointerEvents="box-none"
      exiting={TOAST_EXITING}
      onAccessibilityEscape={onDismiss}
      onLayout={(event) => {
        width.set(event.nativeEvent.layout.width);
      }}
    >
      <GestureDetector gesture={gesture}>
        <Animated.View collapsable={false} entering={toastEntering} style={animatedStyle}>
          {Platform.OS === "android" ? (
            // Keep the dismiss target separate so TalkBack can also focus the action button.
            <View
              accessible
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              accessibilityLabel={props.message}
              accessibilityActions={[{ name: "dismiss", label: "Dismiss message" }]}
              onAccessibilityAction={({ nativeEvent }) => {
                if (nativeEvent.actionName === "dismiss") onDismiss();
              }}
              pointerEvents="none"
              style={StyleSheet.absoluteFill}
            />
          ) : null}
          <ToastContent {...props} glassReady={glassReady} />
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}
