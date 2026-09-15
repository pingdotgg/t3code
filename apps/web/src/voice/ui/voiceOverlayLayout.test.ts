import { describe, expect, it } from "vite-plus/test";

import {
  clampVoiceOverlayPosition,
  shouldAutoCollapseVoiceOverlay,
  VOICE_AUTO_COLLAPSE_MS,
} from "./voiceOverlayLayout";

describe("clampVoiceOverlayPosition", () => {
  it("keeps a position already inside the viewport", () => {
    expect(
      clampVoiceOverlayPosition({ x: 100, y: 80 }, { width: 320, height: 200 }, 1440, 900),
    ).toEqual({ x: 100, y: 80 });
  });

  it("pulls a position back inside the right and bottom edges", () => {
    expect(
      clampVoiceOverlayPosition({ x: 1400, y: 880 }, { width: 320, height: 200 }, 1440, 900),
    ).toEqual({ x: 1440 - 8 - 320, y: 900 - 8 - 200 });
  });

  it("enforces the edge margin on every side", () => {
    expect(
      clampVoiceOverlayPosition({ x: 0, y: 0 }, { width: 320, height: 200 }, 1440, 900),
    ).toEqual({ x: 8, y: 8 });
  });

  it("collapses to the margin when the viewport is smaller than the overlay", () => {
    expect(
      clampVoiceOverlayPosition({ x: 50, y: 50 }, { width: 400, height: 300 }, 200, 100),
    ).toEqual({ x: 8, y: 8 });
  });
});

describe("shouldAutoCollapseVoiceOverlay", () => {
  const quiet = {
    expanded: true,
    phase: "live",
    inFlightTool: null,
    lastActivityAt: 1000,
    now: 1000 + VOICE_AUTO_COLLAPSE_MS,
  };

  it("collapses when a live session has been quiet past the threshold", () => {
    expect(shouldAutoCollapseVoiceOverlay(quiet)).toBe(true);
  });

  it("stays expanded inside the threshold", () => {
    expect(shouldAutoCollapseVoiceOverlay({ ...quiet, now: quiet.now - 1 })).toBe(false);
  });

  it("never collapses the corner button", () => {
    expect(shouldAutoCollapseVoiceOverlay({ ...quiet, expanded: false })).toBe(false);
  });

  it("never collapses when the session is not live", () => {
    expect(shouldAutoCollapseVoiceOverlay({ ...quiet, phase: "connecting" })).toBe(false);
    expect(shouldAutoCollapseVoiceOverlay({ ...quiet, phase: "closed" })).toBe(false);
  });

  it("counts in-flight tool work as activity", () => {
    expect(shouldAutoCollapseVoiceOverlay({ ...quiet, inFlightTool: "voice.searchThreads" })).toBe(
      false,
    );
  });

  it("never collapses before the first activity mark", () => {
    expect(shouldAutoCollapseVoiceOverlay({ ...quiet, lastActivityAt: 0 })).toBe(false);
  });
});
