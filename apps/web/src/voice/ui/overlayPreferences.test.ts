// @vitest-environment jsdom
/**
 * Guarded persistence for the voice overlay preferences: unknown or corrupt
 * stored values fall back to defaults, and updates merge and persist.
 */
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_VOICE_OVERLAY_PREFERENCES,
  sanitizeVoiceOverlayPreferences,
  writeVoiceOverlayPreferences,
  VOICE_ACTIVATION_MODES,
} from "./overlayPreferences";

const KEY = "t3code:voice-overlay:v1";

beforeEach(() => {
  localStorage.clear();
});

describe("sanitizeVoiceOverlayPreferences", () => {
  it("returns defaults for non-object input", () => {
    expect(sanitizeVoiceOverlayPreferences(null)).toEqual(DEFAULT_VOICE_OVERLAY_PREFERENCES);
    expect(sanitizeVoiceOverlayPreferences("nope")).toEqual(DEFAULT_VOICE_OVERLAY_PREFERENCES);
  });

  it("drops an invalid position and unknown activation mode", () => {
    const prefs = sanitizeVoiceOverlayPreferences({
      collapsed: false,
      position: { x: Number.NaN, y: 10 },
      activation: "yell",
    });
    expect(prefs).toEqual({ ...DEFAULT_VOICE_OVERLAY_PREFERENCES, collapsed: false });
  });

  it("keeps a finite position and a known activation mode", () => {
    const prefs = sanitizeVoiceOverlayPreferences({
      collapsed: false,
      position: { x: 12.5, y: 40 },
      activation: "hold",
    });
    expect(prefs).toEqual({ collapsed: false, position: { x: 12.5, y: 40 }, activation: "hold" });
  });

  it("accepts every activation mode the settings UI offers", () => {
    for (const mode of VOICE_ACTIVATION_MODES) {
      expect(sanitizeVoiceOverlayPreferences({ activation: mode }).activation).toBe(mode);
    }
  });
});

describe("writeVoiceOverlayPreferences persistence", () => {
  it("writes a merged record that survives a reload-shaped re-read", () => {
    writeVoiceOverlayPreferences({
      collapsed: false,
      position: { x: 30, y: 60 },
      activation: "double-press",
    });

    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    expect(stored).toEqual({
      collapsed: false,
      position: { x: 30, y: 60 },
      activation: "double-press",
    });
    expect(sanitizeVoiceOverlayPreferences(stored)).toEqual(stored);
  });

  it("a partial update keeps the untouched fields", () => {
    writeVoiceOverlayPreferences({ activation: "always" });
    writeVoiceOverlayPreferences({ collapsed: false });
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    expect(stored.activation).toBe("always");
    expect(stored.collapsed).toBe(false);
  });
});
