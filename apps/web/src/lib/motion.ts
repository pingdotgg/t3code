type SheetSide = "bottom" | "left" | "right" | "top";

function joinClassNames(...classNames: Array<string | false | null | undefined>): string {
  return classNames.filter(Boolean).join(" ");
}

export const DURATION_MICRO_MS = 120 as const;
export const DURATION_UI_MS = 200 as const;
export const DURATION_MODAL_MS = 260 as const;

export const EASE_OUT_CUBIC = [0.215, 0.61, 0.355, 1] as const;
export const EASE_IN_OUT_CUBIC = [0.645, 0.045, 0.355, 1] as const;

export const EASE_OUT_CUBIC_CSS = `cubic-bezier(${EASE_OUT_CUBIC.join(", ")})` as const;
export const EASE_IN_OUT_CUBIC_CSS = `cubic-bezier(${EASE_IN_OUT_CUBIC.join(", ")})` as const;

export const SIDEBAR_LIST_AUTO_ANIMATE_OPTIONS = {
  duration: DURATION_UI_MS,
  easing: EASE_IN_OUT_CUBIC_CSS,
} as const;

export const MODAL_BACKDROP_MOTION_CLASS_NAME = joinClassNames(
  "motion-modal-backdrop",
  "transition-opacity",
  "[transition-duration:var(--motion-duration-modal)]",
  "[transition-timing-function:var(--motion-ease-out)]",
  "data-ending-style:opacity-0",
  "data-starting-style:opacity-0",
);

export const MODAL_POPUP_MOTION_CLASS_NAME = joinClassNames(
  "motion-modal-popup",
  "transition-[scale,opacity,translate]",
  "[transition-duration:var(--motion-duration-modal)]",
  "[transition-timing-function:var(--motion-ease-out)]",
  "will-change-transform",
  "data-ending-style:scale-98",
  "data-starting-style:scale-98",
  "data-ending-style:opacity-0",
  "data-starting-style:opacity-0",
);

export const FLOATING_SURFACE_POSITIONER_MOTION_CLASS_NAME = joinClassNames(
  "motion-floating-positioner",
  "transition-[top,left,right,bottom,transform]",
  "[transition-duration:var(--motion-duration-ui)]",
  "[transition-timing-function:var(--motion-ease-in-out)]",
  "data-instant:transition-none",
);

export const FLOATING_SURFACE_POPUP_MOTION_CLASS_NAME = joinClassNames(
  "motion-floating-popup",
  "transition-[width,height,scale,opacity]",
  "[transition-duration:var(--motion-duration-ui)]",
  "[transition-timing-function:var(--motion-ease-out)]",
  "data-ending-style:scale-98",
  "data-starting-style:scale-98",
  "data-ending-style:opacity-0",
  "data-starting-style:opacity-0",
  "data-instant:duration-0",
);

export function sheetSlideMotionClassName(side: SheetSide): string {
  return joinClassNames(
    "motion-sheet-popup",
    "transition-[opacity,translate]",
    "[transition-duration:var(--motion-duration-modal)]",
    "[transition-timing-function:var(--motion-ease-out)]",
    "will-change-transform",
    "data-ending-style:opacity-0",
    "data-starting-style:opacity-0",
    side === "bottom" && "data-ending-style:translate-y-8 data-starting-style:translate-y-8",
    side === "top" && "data-ending-style:-translate-y-8 data-starting-style:-translate-y-8",
    side === "left" && "data-ending-style:-translate-x-8 data-starting-style:-translate-x-8",
    side === "right" && "data-ending-style:translate-x-8 data-starting-style:translate-x-8",
  );
}

export const MICRO_FADE_MOTION_CLASS_NAME = joinClassNames(
  "motion-micro-fade",
  "transition-opacity",
  "[transition-duration:var(--motion-duration-micro)]",
  "[transition-timing-function:var(--motion-ease-out)]",
);

export const MICRO_FADE_TRANSFORM_MOTION_CLASS_NAME = joinClassNames(
  "motion-micro-fade-transform",
  "transition-[opacity,transform]",
  "[transition-duration:var(--motion-duration-micro)]",
  "[transition-timing-function:var(--motion-ease-out)]",
);
