/**
 * Device-local preferences for the voice overlay UI (collapsed state, screen
 * position, activation mode), persisted in guarded localStorage the same way
 * as the fast-commands preference. Client-local on purpose: nothing here
 * belongs to the server or the wire.
 */
import { useCallback, useSyncExternalStore } from "react";

const KEY = "t3code:voice-overlay:v1";
const EVENT = "t3code:voice-overlay-preferences";

export type VoiceActivationMode = "manual" | "always" | "hold" | "double-press";

export const VOICE_ACTIVATION_MODES: readonly VoiceActivationMode[] = [
  "manual",
  "always",
  "hold",
  "double-press",
];

export const VOICE_ACTIVATION_LABELS: Record<VoiceActivationMode, string> = {
  manual: "Manual",
  always: "Always listening",
  hold: "Hold to talk",
  "double-press": "Double-press to toggle",
};

export interface VoiceOverlayPosition {
  readonly x: number;
  readonly y: number;
}

export interface VoiceOverlayPreferences {
  /** True renders the small corner button; false the full panel. */
  readonly collapsed: boolean;
  /** Top-left corner of the overlay, clamped to the viewport; null anchors
      the overlay in its default bottom-right corner. */
  readonly position: VoiceOverlayPosition | null;
  readonly activation: VoiceActivationMode;
}

export const DEFAULT_VOICE_OVERLAY_PREFERENCES: VoiceOverlayPreferences = {
  collapsed: true,
  position: null,
  activation: "manual",
};

function isActivationMode(value: unknown): value is VoiceActivationMode {
  return typeof value === "string" && VOICE_ACTIVATION_MODES.includes(value as VoiceActivationMode);
}

export function sanitizeVoiceOverlayPreferences(raw: unknown): VoiceOverlayPreferences {
  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_VOICE_OVERLAY_PREFERENCES;
  }
  const record = raw as Record<string, unknown>;
  let position: VoiceOverlayPosition | null = null;
  if (
    typeof record.position === "object" &&
    record.position !== null &&
    Number.isFinite((record.position as Record<string, unknown>).x) &&
    Number.isFinite((record.position as Record<string, unknown>).y)
  ) {
    const rawPosition = record.position as Record<string, unknown>;
    position = { x: rawPosition.x as number, y: rawPosition.y as number };
  }
  return {
    collapsed: typeof record.collapsed === "boolean" ? record.collapsed : true,
    position,
    activation: isActivationMode(record.activation) ? record.activation : "manual",
  };
}

export function readVoiceOverlayPreferences(): VoiceOverlayPreferences {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null
      ? DEFAULT_VOICE_OVERLAY_PREFERENCES
      : sanitizeVoiceOverlayPreferences(JSON.parse(raw));
  } catch {
    return DEFAULT_VOICE_OVERLAY_PREFERENCES;
  }
}

/** Merges a partial update into the stored record. Storage failures are
    swallowed: the overlay still works, it just forgets its placement and
    mode across reloads. */
export function writeVoiceOverlayPreferences(patch: Partial<VoiceOverlayPreferences>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readVoiceOverlayPreferences(), ...patch }));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    // Storage unavailable (quota, privacy mode): see above.
  }
}

function subscribe(listener: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", listener);
  window.addEventListener(EVENT, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(EVENT, listener);
  };
}

export function useVoiceOverlayPreferences(): readonly [
  VoiceOverlayPreferences,
  (update: Partial<VoiceOverlayPreferences>) => void,
] {
  const prefs = useSyncExternalStore(
    subscribe,
    readVoiceOverlayPreferences,
    () => DEFAULT_VOICE_OVERLAY_PREFERENCES,
  );
  const update = useCallback(
    (patch: Partial<VoiceOverlayPreferences>) => writeVoiceOverlayPreferences(patch),
    [],
  );
  return [prefs, update] as const;
}
