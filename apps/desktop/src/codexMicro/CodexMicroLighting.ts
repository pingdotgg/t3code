import {
  CODEX_MICRO_STATUS_COLORS,
  type CodexMicroLighting,
  type CodexMicroSlotStatus,
} from "@t3tools/contracts";

// Firmware effect codes.
const OFF = 0;
const SOLID = 1;
const SNAKE = 2;
const BREATH = 4;
const SHALLOW_BREATH = 6;

const IDLE_DIM = 0.15;

interface Zone {
  readonly e: number;
  readonly b: number;
  readonly s: number;
  readonly m: number;
  readonly c: number;
}

const ZONE_OFF: Zone = { e: OFF, b: 0, s: 0, m: 0, c: 0 };

export interface LightingFrame {
  /** `v.oai.rgbcfg` params. */
  readonly zones: { readonly keys: Zone; readonly ambient: Zone };
  /** `v.oai.thstatus` params. */
  readonly slots: ReadonlyArray<{
    id: number;
    c: number;
    b: number;
    e: number;
    s: number;
    sk: 0;
    sa: 0;
  }>;
}

const SLOT_EFFECT: Record<Exclude<CodexMicroSlotStatus, "off">, { e: number; s: number }> = {
  working: { e: SHALLOW_BREATH, s: 0.4 },
  "needs-input": { e: BREATH, s: 0.7 },
  error: { e: SOLID, s: 0 },
  done: { e: SOLID, s: 0 },
  idle: { e: SOLID, s: 0 },
};

/** Maps what the renderer wants shown to raw firmware lighting params. */
export function lightingFrame(lighting: CodexMicroLighting, lightsOff: boolean): LightingFrame {
  const brightness = lightsOff ? 0 : lighting.brightness;
  const slots = Array.from({ length: 6 }, (_, id) => {
    const slot = lighting.slots[id];
    if (lightsOff || !slot || slot.status === "off")
      return { id, c: 0, b: 0, e: OFF, s: 0, sk: 0, sa: 0 } as const;
    const effect = SLOT_EFFECT[slot.status];
    // The selected key breathes so it's clear which thread the command keys target.
    const highlight = slot.selected && effect.e === SOLID;
    return {
      id,
      c: CODEX_MICRO_STATUS_COLORS[slot.status],
      b: slot.selected || slot.status !== "idle" ? brightness : brightness * IDLE_DIM,
      e: highlight ? SHALLOW_BREATH : effect.e,
      s: highlight ? 0.3 : effect.s,
      sk: 0,
      sa: 0,
    } as const;
  });
  if (lightsOff) return { zones: { keys: ZONE_OFF, ambient: ZONE_OFF }, slots };

  // The ambient ring summarizes the most urgent state across all agent keys.
  const has = (status: CodexMicroSlotStatus) =>
    lighting.slots.some((slot) => slot.status === status);
  const color = CODEX_MICRO_STATUS_COLORS;
  const ambient: Zone = has("needs-input")
    ? { e: BREATH, b: brightness, s: 0.6, m: 0, c: color["needs-input"] }
    : has("working")
      ? { e: SNAKE, b: brightness, s: 0.4, m: 0, c: color.working }
      : has("error")
        ? { e: SOLID, b: brightness * 0.5, s: 0, m: 0, c: color.error }
        : has("done")
          ? { e: SOLID, b: brightness * 0.4, s: 0, m: 0, c: color.done }
          : ZONE_OFF;
  const keys: Zone = lighting.keysBacklight
    ? { e: SOLID, b: brightness * 0.3, s: 0, m: 0, c: color.idle }
    : ZONE_OFF;
  return { zones: { keys, ambient }, slots };
}
