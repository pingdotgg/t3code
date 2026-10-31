/** Resolve every animation by name so configuration and reduced motion apply consistently; niri-
 * config/src/animations.rs supplies the defaults. */
import type { SpringParams } from "./spring";

export type MotionCurve =
  | "linear"
  | "ease-out-quad"
  | "ease-out-cubic"
  | "ease-out-expo"
  | { readonly cubicBezier: readonly [number, number, number, number] };

export type MotionConfig =
  | { readonly kind: "off" }
  | ({ readonly kind: "spring" } & SpringParams)
  | { readonly kind: "easing"; readonly durationMs: number; readonly curve: MotionCurve };

export type MotionName =
  | "workspace-switch"
  | "horizontal-view-movement"
  | "window-movement"
  | "overview-open-close";

const spring = (dampingRatio: number, stiffness: number, epsilon: number): MotionConfig => ({
  kind: "spring",
  dampingRatio,
  stiffness,
  epsilon,
});

/**
 * niri keeps horizontal-view-movement and window-movement equal so panes
 * and the camera moving for the same change stay in step.
 */
const MOTION_DEFAULTS: Readonly<Record<MotionName, MotionConfig>> = {
  "workspace-switch": spring(1, 1000, 0.0001),
  "horizontal-view-movement": spring(1, 800, 0.0001),
  "window-movement": spring(1, 800, 0.0001),
  "overview-open-close": spring(1, 800, 0.0001),
};

interface MotionSettings {
  /** Every animation completes instantly. */
  off: boolean;
  /** Plays every animation this many times slower; gestures stay 1:1. */
  slowdown: number;
  animations: Partial<Record<MotionName, MotionConfig>>;
  /**
   * Settings > Appearance > Panel animations, relative to its 150ms default:
   * how much slower the strip's panes and camera move; 0 is instant.
   */
  panelPace: number;
}

const settings: MotionSettings = { off: false, slowdown: 1, animations: {}, panelPace: 1 };

/** The motions the Panel animations setting paces. */
const PANEL_MOTIONS: ReadonlySet<MotionName> = new Set([
  "horizontal-view-movement",
  "window-movement",
]);

export function configureMotion(next: Partial<MotionSettings>): void {
  if (next.off !== undefined) settings.off = next.off;
  if (next.slowdown !== undefined)
    settings.slowdown = Math.min(1000, Math.max(0.001, next.slowdown));
  if (next.animations) settings.animations = { ...settings.animations, ...next.animations };
  if (next.panelPace !== undefined) settings.panelPace = Math.max(0, next.panelPace);
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { t3Motion: unknown }).t3Motion = { configure: configureMotion, settings };
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The animation `name` plays with now: `off` under reduced motion, the global
 * switch, or (for the strip's panes and camera) Panel animations at 0.
 */
export function resolveMotion(name: MotionName): { config: MotionConfig; slowdown: number } {
  const pace = PANEL_MOTIONS.has(name) ? settings.panelPace : 1;
  if (settings.off || pace <= 0 || prefersReducedMotion()) {
    return { config: { kind: "off" }, slowdown: 1 };
  }
  return {
    config: settings.animations[name] ?? MOTION_DEFAULTS[name],
    slowdown: settings.slowdown * pace,
  };
}
