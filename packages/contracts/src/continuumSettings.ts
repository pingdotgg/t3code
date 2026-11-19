import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Original notification jingles, synthesized on the device (no audio files, no network). */
export const NotificationJingleId = Schema.Literals([
  "soft-chime",
  "digital-pulse",
  "crystal-bell",
  "gentle-piano",
  "ambient-synth",
  "arcade",
  "minimal-pop",
  "classic-desktop",
  "futuristic-signal",
]);
export type NotificationJingleId = typeof NotificationJingleId.Type;

export const NotificationSoundEvent = Schema.Literals([
  "completion",
  "input",
  "approval",
  "long-operation",
  "error",
]);
export type NotificationSoundEvent = typeof NotificationSoundEvent.Type;

const withDefault = <S extends Schema.Top>(schema: S, value: S["Type"]) =>
  schema.pipe(Schema.withDecodingDefault(Effect.succeed(value as S["Encoded"])));

const soundEvent = (enabled: boolean, jingle: NotificationJingleId) =>
  withDefault(
    Schema.Struct({
      enabled: withDefault(Schema.Boolean, enabled),
      jingle: withDefault(NotificationJingleId, jingle),
    }),
    { enabled, jingle },
  );

/** Every field defaults on its own, so settings saved by an older version keep decoding. */
export const NotificationSoundSettings = Schema.Struct({
  volume: withDefault(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })), 0.7),
  muted: withDefault(Schema.Boolean, false),
  /** Silences sounds and desktop notifications; in-app badges still update. */
  doNotDisturb: withDefault(Schema.Boolean, false),
  /** When set, Do Not Disturb ends at this time on its own. */
  doNotDisturbUntil: withDefault(Schema.NullOr(Schema.String), null),
  /** A finished run at least this long plays the long-operation sound instead of completion. */
  longOperationMinutes: withDefault(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 240 })),
    5,
  ),
  events: withDefault(
    Schema.Struct({
      completion: soundEvent(true, "soft-chime"),
      input: soundEvent(true, "digital-pulse"),
      approval: soundEvent(true, "crystal-bell"),
      "long-operation": soundEvent(true, "gentle-piano"),
      error: soundEvent(true, "minimal-pop"),
    }),
    {
      completion: { enabled: true, jingle: "soft-chime" },
      input: { enabled: true, jingle: "digital-pulse" },
      approval: { enabled: true, jingle: "crystal-bell" },
      "long-operation": { enabled: true, jingle: "gentle-piano" },
      error: { enabled: true, jingle: "minimal-pop" },
    },
  ),
});
export type NotificationSoundSettings = typeof NotificationSoundSettings.Type;

export const DEFAULT_NOTIFICATION_SOUND_SETTINGS: NotificationSoundSettings = Schema.decodeSync(
  NotificationSoundSettings,
)({});

export const SpeechReadMode = Schema.Literals(["completed", "streaming"]);
export type SpeechReadMode = typeof SpeechReadMode.Type;

/**
 * `system`: this device's browser or OS voices (Web Speech). `host`: the speech engine of the
 * machine running the Continuum server, for clients without voices such as Electron on Linux.
 */
export const SpeechEngine = Schema.Literals(["system", "host"]);
export type SpeechEngine = typeof SpeechEngine.Type;

/** A word the speech engine says differently, such as `nginx` → `engine x`. */
export const SpeechPronunciation = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
});
export type SpeechPronunciation = typeof SpeechPronunciation.Type;

export const SpeechSettings = Schema.Struct({
  /** Read new agent messages aloud automatically. Replay buttons work either way. */
  autoRead: withDefault(Schema.Boolean, false),
  readMode: withDefault(SpeechReadMode, "completed"),
  engine: withDefault(SpeechEngine, "system"),
  /** The OS voice (`voiceURI`); empty uses the system default voice. */
  voice: withDefault(Schema.String, ""),
  /** A voice id from the host engine; empty uses its default. */
  hostVoice: withDefault(Schema.String, ""),
  rate: withDefault(Schema.Number.check(Schema.isBetween({ minimum: 0.5, maximum: 2.5 })), 1),
  pitch: withDefault(Schema.Number.check(Schema.isBetween({ minimum: 0.5, maximum: 1.5 })), 1),
  volume: withDefault(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })), 1),
  readCodeBlocks: withDefault(Schema.Boolean, false),
  readTerminalOutput: withDefault(Schema.Boolean, false),
  /** Longer messages are cut at a sentence boundary near this many characters. */
  maxCharacters: withDefault(
    Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 20_000 })),
    2_000,
  ),
  stopOnThreadSwitch: withDefault(Schema.Boolean, true),
  pronunciations: withDefault(Schema.Array(SpeechPronunciation), []),
});
export type SpeechSettings = typeof SpeechSettings.Type;

/** The browser profile Entertainment opens sites in, apart from development browsing. */
export const ENTERTAINMENT_BROWSER_PROFILE_ID = "entertainment";

/**
 * Request blocking for the Entertainment browser profile, applied by the desktop app. Lists are
 * ids from `@t3tools/shared/contentBlocking`.
 */
export const EntertainmentBlockingSettings = Schema.Struct({
  enabled: withDefault(Schema.Boolean, true),
  lists: withDefault(Schema.Array(Schema.String), ["trackers", "ads"]),
  customHosts: withDefault(Schema.Array(Schema.String), []),
  allowlist: withDefault(Schema.Array(Schema.String), []),
});
export type EntertainmentBlockingSettings = typeof EntertainmentBlockingSettings.Type;

export const entertainmentBlockingField = EntertainmentBlockingSettings.pipe(
  Schema.withDecodingDefault(Effect.succeed({})),
);

export const notificationSoundsField = NotificationSoundSettings.pipe(
  Schema.withDecodingDefault(Effect.succeed({})),
);
export const speechField = SpeechSettings.pipe(Schema.withDecodingDefault(Effect.succeed({})));
