import type { EntryExitAnimationFunction } from "react-native-reanimated";
import {
  Easing,
  ReduceMotion,
  useReducedMotion,
  withSpring,
  withTiming,
} from "react-native-reanimated";

/**
 * The app's single motion language, mirroring the mac app's Motion enum:
 * every state change picks one of five curves so the whole app moves with
 * one voice. Movement-bearing springs carry ReduceMotion.System and collapse
 * under the system setting; opacity fades stay (fades are the accessible
 * remainder, matching the mac app's reduce-motion fallback).
 *
 * - SNAP: direct responses to a tap — toggles, selection, small reveals.
 * - SETTLE: structural/layout shifts — panes, reflows.
 * - ENTER: new content arriving — cards, banners, heroes.
 * - AMBIENT: passive drift — status tints, progress.
 * - FADE: chrome appearing/disappearing.
 */

/** withSpring config: crisp acknowledgment of a user action. */
export const MOTION_SNAP = {
  duration: 280,
  dampingRatio: 1,
  reduceMotion: ReduceMotion.System,
} as const;

/** withSpring config: calm structural movement. */
export const MOTION_SETTLE = {
  duration: 380,
  dampingRatio: 1,
  reduceMotion: ReduceMotion.System,
} as const;

/** withSpring config: arrivals, with a touch of life (slight overshoot). */
export const MOTION_ENTER = {
  duration: 420,
  dampingRatio: 0.8,
  reduceMotion: ReduceMotion.System,
} as const;

/** withTiming config: ambient, non-attention-seeking drift. */
export const MOTION_AMBIENT = {
  duration: 300,
  easing: Easing.inOut(Easing.ease),
  reduceMotion: ReduceMotion.System,
} as const;

/** withTiming config: quick chrome fades. */
export const MOTION_FADE = {
  duration: 180,
  easing: Easing.out(Easing.ease),
} as const;

/**
 * Entering preset for timeline-ish content: fade plus a short upward drift.
 * The drift spring collapses under Reduce Motion; the fade remains.
 * Do NOT attach to recycled list rows — recycling replays entering
 * animations on every reuse.
 */
export function rise(): EntryExitAnimationFunction {
  return () => {
    "worklet";
    return {
      initialValues: { opacity: 0, transform: [{ translateY: 12 }] },
      animations: {
        opacity: withTiming(1, { duration: 300, easing: Easing.out(Easing.ease) }),
        transform: [{ translateY: withSpring(0, MOTION_ENTER) }],
      },
    };
  };
}

/** Entering preset for cards/sheets: fade plus scale-up from 96%. */
export function materialize(): EntryExitAnimationFunction {
  return () => {
    "worklet";
    return {
      initialValues: { opacity: 0, transform: [{ scale: 0.96 }] },
      animations: {
        opacity: withTiming(1, { duration: 300, easing: Easing.out(Easing.ease) }),
        transform: [{ scale: withSpring(1, MOTION_ENTER) }],
      },
    };
  };
}

/** Entering preset for banners/pills dropping in from above. */
export function bannerDrop(): EntryExitAnimationFunction {
  return () => {
    "worklet";
    return {
      initialValues: { opacity: 0, transform: [{ translateY: -8 }] },
      animations: {
        opacity: withTiming(1, { duration: 240, easing: Easing.out(Easing.ease) }),
        transform: [{ translateY: withSpring(0, MOTION_SNAP) }],
      },
    };
  };
}

/**
 * For the few non-reanimated consumers (expo-image transitions, decorative
 * loops) that need to shorten or drop movement manually.
 */
export const useMotionReduced = useReducedMotion;
