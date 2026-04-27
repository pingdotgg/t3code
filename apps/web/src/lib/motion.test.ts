import { describe, expect, it } from "vitest";

import {
  DURATION_MICRO_MS,
  DURATION_MODAL_MS,
  DURATION_UI_MS,
  EASE_IN_OUT_CUBIC,
  EASE_IN_OUT_CUBIC_CSS,
  EASE_OUT_CUBIC,
  EASE_OUT_CUBIC_CSS,
  FLOATING_SURFACE_POPUP_MOTION_CLASS_NAME,
  FLOATING_SURFACE_POSITIONER_MOTION_CLASS_NAME,
  MICRO_FADE_MOTION_CLASS_NAME,
  MICRO_FADE_TRANSFORM_MOTION_CLASS_NAME,
  MODAL_BACKDROP_MOTION_CLASS_NAME,
  MODAL_POPUP_MOTION_CLASS_NAME,
  SIDEBAR_LIST_AUTO_ANIMATE_OPTIONS,
  sheetSlideMotionClassName,
} from "./motion";

describe("motion tokens", () => {
  it("exports the canonical duration values", () => {
    expect(DURATION_MICRO_MS).toBe(120);
    expect(DURATION_UI_MS).toBe(200);
    expect(DURATION_MODAL_MS).toBe(260);
  });

  it("exports the shared easing curves and CSS strings", () => {
    expect(EASE_OUT_CUBIC).toEqual([0.215, 0.61, 0.355, 1]);
    expect(EASE_IN_OUT_CUBIC).toEqual([0.645, 0.045, 0.355, 1]);
    expect(EASE_OUT_CUBIC_CSS).toBe("cubic-bezier(0.215, 0.61, 0.355, 1)");
    expect(EASE_IN_OUT_CUBIC_CSS).toBe("cubic-bezier(0.645, 0.045, 0.355, 1)");
  });

  it("exports the sidebar auto-animate options", () => {
    expect(SIDEBAR_LIST_AUTO_ANIMATE_OPTIONS).toEqual({
      duration: DURATION_UI_MS,
      easing: EASE_IN_OUT_CUBIC_CSS,
    });
  });
});

describe("motion class helpers", () => {
  it("includes the shared modal and floating motion anchors", () => {
    expect(MODAL_BACKDROP_MOTION_CLASS_NAME).toContain("motion-modal-backdrop");
    expect(MODAL_BACKDROP_MOTION_CLASS_NAME).toContain(
      "[transition-duration:var(--motion-duration-modal)]",
    );
    expect(MODAL_POPUP_MOTION_CLASS_NAME).toContain("motion-modal-popup");
    expect(MODAL_POPUP_MOTION_CLASS_NAME).toContain("data-starting-style:scale-98");
    expect(FLOATING_SURFACE_POSITIONER_MOTION_CLASS_NAME).toContain("motion-floating-positioner");
    expect(FLOATING_SURFACE_POSITIONER_MOTION_CLASS_NAME).toContain("data-instant:transition-none");
    expect(FLOATING_SURFACE_POPUP_MOTION_CLASS_NAME).toContain("motion-floating-popup");
    expect(FLOATING_SURFACE_POPUP_MOTION_CLASS_NAME).toContain(
      "[transition-duration:var(--motion-duration-ui)]",
    );
  });

  it("builds side-specific sheet motion classes", () => {
    expect(sheetSlideMotionClassName("bottom")).toContain("data-starting-style:translate-y-8");
    expect(sheetSlideMotionClassName("top")).toContain("data-starting-style:-translate-y-8");
    expect(sheetSlideMotionClassName("left")).toContain("data-starting-style:-translate-x-8");
    expect(sheetSlideMotionClassName("right")).toContain("data-starting-style:translate-x-8");
  });

  it("exports the micro motion helpers", () => {
    expect(MICRO_FADE_MOTION_CLASS_NAME).toContain("motion-micro-fade");
    expect(MICRO_FADE_MOTION_CLASS_NAME).toContain("transition-opacity");
    expect(MICRO_FADE_TRANSFORM_MOTION_CLASS_NAME).toContain("transition-[opacity,transform]");
  });
});
