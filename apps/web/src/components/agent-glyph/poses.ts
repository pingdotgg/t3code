/**
 * Official T3 wordmark, outlined from `assets/prod/logo.svg` so the glyph
 * does not depend on a live webfont. A pose is only numbers; morph is lerp.
 */

export const AGENT_GLYPH_STATUSES = [
  "idle",
  "think",
  "work",
  "test",
  "ui-test",
  "wait",
  "review",
  "debug",
] as const;

export type AgentGlyphStatus = (typeof AGENT_GLYPH_STATUSES)[number];

/** Transient settle target after a live turn, then we lerp to idle. */
export type AgentGlyphPoseName = AgentGlyphStatus | "done";

export const GLYPH_VIEWBOX = "10 31 106 69";
export const GLYPH_CX = 63;
export const GLYPH_CY = 65.5;
export const T_PIVOT_X = 40;
export const T_PIVOT_Y = 65;
export const BAR_PIVOT_X = 39.93;
export const BAR_PIVOT_Y = 42.28;
export const THREE_PIVOT_X = 87.65;
export const THREE_PIVOT_Y = 65.48;

export const T_STEM_PATH = "M33.4509 93V47.56H46.4109V93H33.4509Z";
export const T_BAR_PATH = "M15.5309 47.56V37H64.3309V47.56H15.5309Z";
export const THREE_PATH =
  "M86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z";

export type GlyphPose = {
  groupX: number;
  groupY: number;
  groupRotate: number;
  groupScale: number;
  tRotate: number;
  barRotate: number;
  threeRotate: number;
  threeScaleX: number;
  threeScaleY: number;
  eyeCx: number;
  eyeCy: number;
  eyeRx: number;
  eyeRy: number;
  eyeOpacity: number;
  flutterAmp: number;
  flutterSpeed: number;
};

const REST_EYE = { eyeCx: 92.2, eyeCy: 79.6, eyeRx: 11, eyeRy: 12, eyeOpacity: 1 };

const rest = (overrides: Partial<GlyphPose> = {}): GlyphPose => ({
  groupX: 0,
  groupY: 0,
  groupRotate: 0,
  groupScale: 1,
  tRotate: 0,
  barRotate: 0,
  threeRotate: 0,
  threeScaleX: 1,
  threeScaleY: 1,
  ...REST_EYE,
  flutterAmp: 0,
  flutterSpeed: 1,
  ...overrides,
});

export const GLYPH_POSES = {
  idle: rest(),
  think: rest({
    groupY: -0.4,
    eyeRy: 5.2,
    eyeRx: 12,
    flutterAmp: 0.9,
    flutterSpeed: 1,
  }),
  work: rest({
    groupRotate: -7,
    tRotate: -4,
    barRotate: 6,
    eyeRy: 6.4,
    flutterAmp: 1.15,
    flutterSpeed: 1.55,
  }),
  test: rest({
    tRotate: -18,
    barRotate: 28,
    groupY: -0.3,
    eyeRy: 9,
    eyeRx: 12.5,
    flutterAmp: 0.7,
    flutterSpeed: 1.25,
  }),
  "ui-test": rest({
    groupRotate: 4,
    eyeCx: 99.8,
    eyeCy: 77.4,
    eyeRx: 7.5,
    eyeRy: 11,
    flutterAmp: 0.55,
    flutterSpeed: 0.85,
  }),
  wait: rest({
    groupScale: 1.04,
    eyeCx: 90.4,
    eyeCy: 80.6,
    eyeRx: 13.5,
    eyeRy: 14.5,
    flutterAmp: 0,
    flutterSpeed: 1,
  }),
  review: rest({
    groupRotate: -3,
    tRotate: -2,
    barRotate: 4,
    eyeRy: 8,
    flutterAmp: 0,
    flutterSpeed: 1,
  }),
  debug: rest({
    groupRotate: 5,
    threeScaleX: 1.08,
    threeScaleY: 0.82,
    tRotate: 6,
    eyeCx: 87.6,
    eyeCy: 82.2,
    eyeRx: 14,
    eyeRy: 4.2,
    flutterAmp: 0,
    flutterSpeed: 1,
  }),
  done: rest({
    groupScale: 1.06,
    tRotate: -12,
    barRotate: 22,
    eyeRx: 12.5,
    eyeRy: 13.5,
    flutterAmp: 0,
    flutterSpeed: 1,
  }),
} as const satisfies Record<AgentGlyphPoseName, GlyphPose>;

export const GLYPH_POSE_FIELDS = [
  "groupX",
  "groupY",
  "groupRotate",
  "groupScale",
  "tRotate",
  "barRotate",
  "threeRotate",
  "threeScaleX",
  "threeScaleY",
  "eyeCx",
  "eyeCy",
  "eyeRx",
  "eyeRy",
  "eyeOpacity",
  "flutterAmp",
  "flutterSpeed",
] as const satisfies ReadonlyArray<keyof GlyphPose>;

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

export function lerpPose(from: GlyphPose, to: GlyphPose, t: number): GlyphPose {
  const next = { ...from };
  for (const field of GLYPH_POSE_FIELDS) {
    next[field] = lerp(from[field], to[field], t);
  }
  return next;
}

export function poseDistance(from: GlyphPose, to: GlyphPose): number {
  let max = 0;
  for (const field of GLYPH_POSE_FIELDS) {
    const delta = Math.abs(from[field] - to[field]);
    if (delta > max) max = delta;
  }
  return max;
}

export function clonePose(pose: GlyphPose): GlyphPose {
  return { ...pose };
}

/** Two stacked sines on Y plus a tiny scale pulse. Amplitude is ~1px at 24px. */
export function flutterOffset(
  nowMs: number,
  amp: number,
  speed: number,
): { y: number; scale: number } {
  if (amp <= 0) return { y: 0, scale: 1 };
  const t = (nowMs / 1000) * speed;
  const y = amp * Math.sin(t * 2.1) + amp * 0.45 * Math.sin(t * 3.7);
  const scale = 1 + amp * 0.012 * Math.sin(t * 2.7);
  return { y, scale };
}

export function isLiveGlyphStatus(status: AgentGlyphStatus): boolean {
  return status === "think" || status === "work" || status === "test" || status === "ui-test";
}

export function glyphStatusLabel(status: AgentGlyphStatus): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "think":
      return "Thinking";
    case "work":
      return "Working";
    case "test":
      return "Testing";
    case "ui-test":
      return "Watching the UI";
    case "wait":
      return "Waiting for you";
    case "review":
      return "Reviewing";
    case "debug":
      return "Error";
  }
}
