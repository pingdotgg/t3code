/**
 * The app's motion language. Port of
 * `apps/mac/Sources/SergeCodeMac/Theme/Motion.swift`.
 *
 * Every interactive state change routes through a purpose-specific curve so
 * frequent feedback stays crisp while occasional structure and rare success
 * moments retain a calm alpine personality.
 *
 * Accessibility: when the OS asks for reduced motion, every movement-bearing
 * curve collapses to a quick fade and every transition to plain opacity —
 * state changes still ease (no jarring pops) but nothing slides, scales,
 * springs, or pulses. macOS reads
 * `NSWorkspace.accessibilityDisplayShouldReduceMotion`; the web equivalent is
 * `prefers-reduced-motion`, which Windows 11 drives from
 * Settings ▸ Accessibility ▸ Visual effects ▸ Animation effects.
 *
 * Keeping the policy free of any view type is what makes its responsiveness
 * and reduce-motion guarantees directly testable, exactly as on macOS.
 */

export interface MotionProfile {
  readonly reduceMotion: boolean;
  readonly feedbackDuration: number;
  readonly revealDuration: number;
  readonly structureDuration: number;
  readonly delightDuration: number;
  /**
   * One-shot effort-change burst: long enough to read as playful, short enough
   * that rapid switching never queues overlapping ripples.
   */
  readonly burstDuration: number;
  readonly changeDuration: number;
  readonly usesMovement: boolean;
  readonly allowsDecorativeEffects: boolean;
}

export function motionProfile(reduceMotion: boolean): MotionProfile {
  const revealDuration = 0.19;
  return {
    reduceMotion,
    feedbackDuration: 0.14,
    revealDuration,
    structureDuration: 0.24,
    delightDuration: 0.4,
    burstDuration: 0.6,
    changeDuration: reduceMotion ? 0.12 : revealDuration,
    usesMovement: !reduceMotion,
    allowsDecorativeEffects: !reduceMotion,
  };
}

/** A CSS transition: duration in seconds plus a timing function. */
export interface Curve {
  readonly duration: number;
  readonly easing: string;
}

export function curveCss(curve: Curve): string {
  return `${curve.duration}s ${curve.easing}`;
}

const EASE_OUT = "ease-out";
/** SwiftUI `timingCurve(0.23, 1, 0.32, 1, …)` — the app's signature ease-out. */
const SIGNATURE = "cubic-bezier(0.23, 1, 0.32, 1)";
/** SwiftUI `.smooth`: interruptible, no overshoot around text. */
const SMOOTH = "cubic-bezier(0.4, 0, 0.2, 1)";
/**
 * SwiftUI `.spring(duration:bounce: 0.18)`. CSS has `linear()` for sampled
 * springs, but a single overshooting bezier is visually equivalent at this
 * bounce and stays interruptible.
 */
const SPRING = "cubic-bezier(0.34, 1.32, 0.64, 1)";
/** SwiftUI `timingCurve(0.77, 0, 0.175, 1, …)` — the ambient in-out. */
const AMBIENT = "cubic-bezier(0.77, 0, 0.175, 1)";

function reducedChange(profile: MotionProfile): Curve {
  return { duration: profile.changeDuration, easing: EASE_OUT };
}

/**
 * Pointer-driven press feedback and small icon changes. Keyboard actions
 * should not opt into this animation at all.
 */
export function feedback(profile: MotionProfile): Curve {
  return profile.reduceMotion
    ? reducedChange(profile)
    : { duration: profile.feedbackDuration, easing: SIGNATURE };
}

/**
 * Compact content entering or leaving: suggestions, chips, banners, and newly
 * appended user-visible blocks.
 */
export function reveal(profile: MotionProfile): Curve {
  return profile.reduceMotion
    ? reducedChange(profile)
    : { duration: profile.revealDuration, easing: SIGNATURE };
}

/** Occasional panels, disclosures, and intentional layout changes. */
export function structure(profile: MotionProfile): Curve {
  return profile.reduceMotion
    ? reducedChange(profile)
    : { duration: profile.structureDuration, easing: SMOOTH };
}

/** A one-shot accent for rare successful state transitions. */
export function delight(profile: MotionProfile): Curve {
  return profile.reduceMotion
    ? reducedChange(profile)
    : { duration: profile.delightDuration, easing: SPRING };
}

/**
 * The one-shot colorful ripple behind a control when reasoning effort changes.
 * Call sites must additionally gate the burst element on
 * `allowsDecorativeEffects`; this curve is only its timing.
 */
export function burst(profile: MotionProfile): Curve {
  return {
    duration: profile.reduceMotion ? profile.changeDuration : profile.burstDuration,
    easing: EASE_OUT,
  };
}

/** Asynchronous status tint, opacity, and meter changes. */
export function ambient(profile: MotionProfile): Curve {
  return { duration: profile.reduceMotion ? 0.12 : 0.22, easing: AMBIENT };
}

/** Occasional scenery changes are atmospheric rather than interactive. */
export function scenery(profile: MotionProfile): Curve {
  return { duration: profile.reduceMotion ? 0.12 : 0.3, easing: AMBIENT };
}

/**
 * Transition descriptors. SwiftUI composes insertion/removal transitions;
 * the CSS port hands these to a `data-transition` attribute that the stylesheet
 * turns into keyframes, so the reduce-motion collapse stays in one place.
 */
export type TransitionName =
  /** New timeline content rising into place. */
  | "rise"
  /** Cards and sheets materializing. */
  | "materialize"
  /** Transient overlays popping from an edge anchor. */
  | "pop"
  /** Banners and pills revealing from their nearby container edge. */
  | "banner"
  /** Inline detail unfolding beneath a disclosure row. */
  | "unfold"
  /** Cross-fade with a whisper of scale for swapping whole panes. */
  | "pane-change"
  /** Reduce Motion's universal replacement. */
  | "opacity";

export function transition(name: TransitionName, profile: MotionProfile): TransitionName {
  return profile.reduceMotion ? "opacity" : name;
}

/** Reads the OS preference. Falls back to "no reduction" outside a browser. */
export function prefersReducedMotion(): boolean {
  if (typeof globalThis.matchMedia !== "function") {
    return false;
  }
  return globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Every curve, as CSS custom properties. Applied to the document root and
 * recomputed when the reduce-motion preference changes, so a settings change
 * applies from the next state change onward — the same guarantee the macOS
 * `Motion` enum gets by reading the preference per access.
 */
export function motionCssVariables(profile: MotionProfile): Record<string, string> {
  return {
    "--motion-feedback": curveCss(feedback(profile)),
    "--motion-reveal": curveCss(reveal(profile)),
    "--motion-structure": curveCss(structure(profile)),
    "--motion-delight": curveCss(delight(profile)),
    "--motion-burst": curveCss(burst(profile)),
    "--motion-ambient": curveCss(ambient(profile)),
    "--motion-scenery": curveCss(scenery(profile)),
    "--motion-decorative-opacity": profile.allowsDecorativeEffects ? "1" : "0",
  };
}
