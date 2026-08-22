import { useEffect, type ReactNode } from "react";
import Animated, { makeMutable, useAnimatedStyle, useReducedMotion } from "react-native-reanimated";

const STATUS_PULSE_STEPS = [
  { delayMs: 800, opacity: 0.875 },
  { delayMs: 50, opacity: 0.75 },
  { delayMs: 50, opacity: 0.625 },
  { delayMs: 50, opacity: 0.5 },
  { delayMs: 800, opacity: 0.625 },
  { delayMs: 50, opacity: 0.75 },
  { delayMs: 50, opacity: 0.875 },
  { delayMs: 50, opacity: 1 },
] as const;

const sharedStatusPulseOpacity = makeMutable(1);
let activeStatusPulseCount = 0;
let statusPulseStep = 0;
let statusPulseTimer: ReturnType<typeof setTimeout> | null = null;

function stopSharedStatusPulse() {
  if (statusPulseTimer !== null) {
    clearTimeout(statusPulseTimer);
    statusPulseTimer = null;
  }
  statusPulseStep = 0;
  sharedStatusPulseOpacity.value = 1;
}

function scheduleSharedStatusPulse() {
  if (activeStatusPulseCount === 0 || statusPulseTimer !== null) {
    return;
  }

  const step = STATUS_PULSE_STEPS[statusPulseStep];
  statusPulseTimer = setTimeout(() => {
    statusPulseTimer = null;
    if (activeStatusPulseCount === 0) {
      stopSharedStatusPulse();
      return;
    }
    sharedStatusPulseOpacity.value = step.opacity;
    statusPulseStep = (statusPulseStep + 1) % STATUS_PULSE_STEPS.length;
    scheduleSharedStatusPulse();
  }, step.delayMs);
}

function subscribeToSharedStatusPulse() {
  activeStatusPulseCount += 1;
  scheduleSharedStatusPulse();
  return () => {
    activeStatusPulseCount = Math.max(0, activeStatusPulseCount - 1);
    if (activeStatusPulseCount === 0) {
      stopSharedStatusPulse();
    }
  };
}

function ActiveStatusPulse(props: { readonly children: ReactNode }) {
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (reduceMotion) {
      return;
    }
    return subscribeToSharedStatusPulse();
  }, [reduceMotion]);

  const animatedStyle = useAnimatedStyle(
    () => ({ opacity: reduceMotion ? 1 : sharedStatusPulseOpacity.value }),
    [reduceMotion],
  );

  return <Animated.View style={animatedStyle}>{props.children}</Animated.View>;
}

/** A shared, display-rate-independent status pulse for persistent activity indicators. */
export function StatusPulse(props: { readonly active: boolean; readonly children: ReactNode }) {
  return props.active ? <ActiveStatusPulse>{props.children}</ActiveStatusPulse> : props.children;
}
