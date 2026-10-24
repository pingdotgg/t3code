import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { KeybindingCommand } from "./keybindings.ts";

/**
 * Work Louder Codex Micro: six agent keys that mirror threads, seven command
 * keys, a knob and an analog stick. The desktop main process owns the HID
 * connection; the renderer decides what the keys show and do.
 */

export const CODEX_MICRO_SLOT_COUNT = 6;

export const CodexMicroSlotStatus = Schema.Literals([
  "off",
  "idle",
  "working",
  "needs-input",
  "done",
  "error",
]);
export type CodexMicroSlotStatus = typeof CodexMicroSlotStatus.Type;

export const CodexMicroControlId = Schema.Literals([
  "ACT06",
  "ACT07",
  "ACT08",
  "ACT09",
  "ACT10",
  "ACT11",
  "ACT12",
  "ENC",
  "ENC_CW",
  "ENC_CC",
  "JOY_UP",
  "JOY_DOWN",
  "JOY_LEFT",
  "JOY_RIGHT",
]);
export type CodexMicroControlId = typeof CodexMicroControlId.Type;

export const CodexMicroAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({ type: Schema.Literal("approve") }),
  Schema.Struct({ type: Schema.Literal("approveForSession") }),
  Schema.Struct({ type: Schema.Literal("decline") }),
  Schema.Struct({ type: Schema.Literal("stop") }),
  Schema.Struct({ type: Schema.Literal("nextSlot") }),
  Schema.Struct({ type: Schema.Literal("previousSlot") }),
  Schema.Struct({ type: Schema.Literal("focusApp") }),
  Schema.Struct({ type: Schema.Literal("command"), command: KeybindingCommand }),
]);
export type CodexMicroAction = typeof CodexMicroAction.Type;

export const CodexMicroAgentMode = Schema.Literals(["priority", "pinned", "recent"]);
export type CodexMicroAgentMode = typeof CodexMicroAgentMode.Type;

export const CodexMicroKnobMode = Schema.Literals(["agents", "threads", "custom"]);
export type CodexMicroKnobMode = typeof CodexMicroKnobMode.Type;

export const DEFAULT_CODEX_MICRO_CONTROLS: Readonly<Record<CodexMicroControlId, CodexMicroAction>> =
  {
    ACT06: { type: "approve" },
    ACT07: { type: "decline" },
    ACT08: { type: "stop" },
    ACT09: { type: "command", command: "chat.new" },
    ACT10: { type: "command", command: "terminal.toggle" },
    ACT11: { type: "command", command: "diff.toggle" },
    ACT12: { type: "command", command: "commandPalette.toggle" },
    ENC: { type: "focusApp" },
    ENC_CW: { type: "nextSlot" },
    ENC_CC: { type: "previousSlot" },
    JOY_UP: { type: "command", command: "thread.previous" },
    JOY_DOWN: { type: "command", command: "thread.next" },
    JOY_LEFT: { type: "command", command: "navigation.back" },
    JOY_RIGHT: { type: "command", command: "navigation.forward" },
  };

const Brightness = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const AutoDimMs = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 24 * 60 * 60_000 })),
);

const CodexMicroSettingsValue = Schema.Struct({
  agentMode: CodexMicroAgentMode,
  knobMode: CodexMicroKnobMode,
  /** One wide keycap covers ACT10 + ACT11; when false only ACT10 is used. */
  separateMicrophoneKeys: Schema.Boolean,
  /** Bring T3 Code forward on a single agent-key tap instead of a double tap. */
  singleTapFocus: Schema.Boolean,
  /** Thread ids pinned to agent keys 1–6 (null = follow `agentMode`). */
  pinnedThreads: Schema.Array(Schema.NullOr(Schema.String)),
  controls: Schema.Record(CodexMicroControlId, CodexMicroAction),
  brightness: Brightness,
  autoDimMs: AutoDimMs,
  keysBacklight: Schema.Boolean,
});
type CodexMicroSettingsValue = typeof CodexMicroSettingsValue.Type;

export const DEFAULT_CODEX_MICRO_SETTINGS: CodexMicroSettingsValue = {
  agentMode: "priority",
  knobMode: "agents",
  separateMicrophoneKeys: false,
  singleTapFocus: false,
  pinnedThreads: [null, null, null, null, null, null],
  controls: DEFAULT_CODEX_MICRO_CONTROLS,
  brightness: 0.8,
  autoDimMs: 600_000,
  keysBacklight: false,
};

const decodeField = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownOption(schema as never);
const FIELD_DECODERS = {
  agentMode: decodeField(CodexMicroAgentMode),
  knobMode: decodeField(CodexMicroKnobMode),
  separateMicrophoneKeys: decodeField(Schema.Boolean),
  singleTapFocus: decodeField(Schema.Boolean),
  pinnedThreads: decodeField(Schema.Array(Schema.NullOr(Schema.String))),
  brightness: decodeField(Brightness),
  autoDimMs: decodeField(AutoDimMs),
  keysBacklight: decodeField(Schema.Boolean),
};
const decodeAction = Schema.decodeUnknownOption(CodexMicroAction);

/**
 * Stored settings outlive the code that wrote them: a control or keybinding
 * command can be renamed or removed. Each field falls back to its default on
 * its own, so one stale value never invalidates the rest of the client settings.
 */
function sanitizeCodexMicroSettings(raw: unknown): CodexMicroSettingsValue {
  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const pick = <K extends keyof typeof FIELD_DECODERS>(key: K): CodexMicroSettingsValue[K] => {
    const decoded = FIELD_DECODERS[key](input[key]);
    return (
      decoded._tag === "Some" ? decoded.value : DEFAULT_CODEX_MICRO_SETTINGS[key]
    ) as CodexMicroSettingsValue[K];
  };
  const storedControls =
    typeof input.controls === "object" && input.controls !== null
      ? (input.controls as Record<string, unknown>)
      : {};
  const controls = { ...DEFAULT_CODEX_MICRO_CONTROLS };
  for (const id of CodexMicroControlId.literals) {
    const action = decodeAction(storedControls[id]);
    if (action._tag === "Some") controls[id] = action.value;
  }
  return {
    agentMode: pick("agentMode"),
    knobMode: pick("knobMode"),
    separateMicrophoneKeys: pick("separateMicrophoneKeys"),
    singleTapFocus: pick("singleTapFocus"),
    pinnedThreads: pick("pinnedThreads"),
    controls,
    brightness: pick("brightness"),
    autoDimMs: pick("autoDimMs"),
    keysBacklight: pick("keysBacklight"),
  };
}

export const CodexMicroSettings = Schema.Unknown.pipe(
  Schema.decodeTo(
    CodexMicroSettingsValue,
    SchemaTransformation.transform<typeof CodexMicroSettingsValue.Encoded, unknown>({
      decode: sanitizeCodexMicroSettings,
      encode: (settings) => settings,
    }),
  ),
);
export type CodexMicroSettings = typeof CodexMicroSettings.Type;

export const CodexMicroDeviceState = Schema.Struct({
  connected: Schema.Boolean,
  firmwareVersion: Schema.NullOr(Schema.String),
  batteryPercentage: Schema.NullOr(Schema.Number),
  charging: Schema.NullOr(Schema.Boolean),
});
export type CodexMicroDeviceState = typeof CodexMicroDeviceState.Type;

export const DISCONNECTED_CODEX_MICRO_STATE: CodexMicroDeviceState = {
  connected: false,
  firmwareVersion: null,
  batteryPercentage: null,
  charging: null,
};

/** `act`: 1 press, 0 release, 2 knob tick. Keys: AG00–AG05, ACT06–ACT12, ENC*, ENC_CW, ENC_CC. */
export const CodexMicroInputEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("key"),
    key: Schema.String,
    act: Schema.NullOr(Schema.Number),
  }),
  /** angle 0–1 clockwise from +x in screen space (0.75 = up); distance 0–1. */
  Schema.Struct({
    type: Schema.Literal("joystick"),
    angle: Schema.Number,
    distance: Schema.Number,
  }),
]);
export type CodexMicroInputEvent = typeof CodexMicroInputEvent.Type;

export const CodexMicroEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("state"), state: CodexMicroDeviceState }),
  Schema.Struct({ type: Schema.Literal("input"), input: CodexMicroInputEvent }),
]);
export type CodexMicroEvent = typeof CodexMicroEvent.Type;

/** What the renderer wants the device to show; the main process maps it to LEDs. */
export const CodexMicroLighting = Schema.Struct({
  slots: Schema.Array(
    Schema.Struct({ status: CodexMicroSlotStatus, selected: Schema.Boolean }),
  ).check(Schema.isMaxLength(CODEX_MICRO_SLOT_COUNT)),
  brightness: Brightness,
  autoDimMs: AutoDimMs,
  keysBacklight: Schema.Boolean,
});
export type CodexMicroLighting = typeof CodexMicroLighting.Type;

/** Codex Micro's own status colors (packed RGB). */
export const CODEX_MICRO_STATUS_COLORS: Readonly<
  Record<Exclude<CodexMicroSlotStatus, "off">, number>
> = {
  working: 0x304ffe,
  "needs-input": 0xff6d00,
  done: 0x00ff4c,
  error: 0xff0033,
  idle: 0xffffff,
};
