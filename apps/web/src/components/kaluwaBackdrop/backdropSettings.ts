// Fork: Kaluwa's backdrop art settings. Kept in their own local-storage key, apart from the
// shared client settings, so upstream's settings shape stays untouched.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const GENERATED_ARTS = [
  "horse",
  "herd",
  "waves",
  "ridges",
  "lotus",
  "moonstone",
  "palms",
  "contours",
  "stars",
  "aurora",
  "halftone",
  "grain",
] as const;
export type GeneratedArt = (typeof GENERATED_ARTS)[number];

/**
 * Palette swatches the theme exposes as `--kaluwa-swatch-<name>`. The palette's first slot is
 * the accent, which the "accent" colour mode already follows.
 */
export const BACKDROP_SWATCHES = [
  "clay",
  "ochre",
  "sand",
  "moss",
  "sage",
  "lagoon",
  "steel",
  "slate",
  "dusk",
  "plum",
  "rose",
  "ash",
  "bone",
] as const;
export type BackdropSwatch = (typeof BACKDROP_SWATCHES)[number];

const UPLOAD_PREFIX = "upload:";
export const uploadArtId = (uploadId: string) => `${UPLOAD_PREFIX}${uploadId}`;
export const uploadIdOfArt = (art: string): string | null =>
  art.startsWith(UPLOAD_PREFIX) ? art.slice(UPLOAD_PREFIX.length) : null;
export const isGeneratedArt = (art: string): art is GeneratedArt =>
  (GENERATED_ARTS as ReadonlyArray<string>).includes(art);

const bounded = (minimum: number, maximum: number, fallback: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum })).pipe(
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export const BACKDROP_LIMITS = {
  cell: [2, 12],
  density: [5, 100],
  opacity: [5, 100],
  fade: [0, 100],
  inThreads: [0, 100],
  seed: [1, 40],
  threshold: [5, 95],
  contrast: [-100, 100],
  brightness: [-100, 100],
  focus: [0, 100],
  tint: [0, 100],
  blur: [0, 30],
  wash: [0, 95],
} as const satisfies Record<string, readonly [number, number]>;

export const BackdropImageSettingsSchema = Schema.Struct({
  mode: Schema.Literals(["dither", "photo"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("dither" as const)),
  ),
  dither: Schema.Literals(["atkinson", "floyd", "ordered"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("atkinson" as const)),
  ),
  threshold: bounded(...BACKDROP_LIMITS.threshold, 50),
  contrast: bounded(...BACKDROP_LIMITS.contrast, 10),
  brightness: bounded(...BACKDROP_LIMITS.brightness, 0),
  invert: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  fit: Schema.Literals(["fill", "fit"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("fill" as const)),
  ),
  focusX: bounded(...BACKDROP_LIMITS.focus, 50),
  focusY: bounded(...BACKDROP_LIMITS.focus, 50),
  tint: bounded(...BACKDROP_LIMITS.tint, 35),
  blur: bounded(...BACKDROP_LIMITS.blur, 0),
  wash: bounded(...BACKDROP_LIMITS.wash, 45),
});
export type BackdropImageSettings = typeof BackdropImageSettingsSchema.Type;

export const KaluwaBackdropSettingsSchema = Schema.Struct({
  /** A generated art id, `upload:<id>`, or "none". */
  art: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("none"))),
  pattern: Schema.Literals(["scatter", "ordered"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("scatter" as const)),
  ),
  shape: Schema.Literals(["square", "round"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("square" as const)),
  ),
  cell: bounded(...BACKDROP_LIMITS.cell, 4),
  density: bounded(...BACKDROP_LIMITS.density, 58),
  opacity: bounded(...BACKDROP_LIMITS.opacity, 88),
  fade: bounded(...BACKDROP_LIMITS.fade, 75),
  inThreads: bounded(...BACKDROP_LIMITS.inThreads, 30),
  placement: Schema.Literals(["full", "bottom", "home"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("full" as const)),
  ),
  colorMode: Schema.Literals(["accent", "swatch"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("accent" as const)),
  ),
  swatch: Schema.Literals(BACKDROP_SWATCHES).pipe(
    Schema.withDecodingDefault(Effect.succeed("clay" as const)),
  ),
  seed: bounded(...BACKDROP_LIMITS.seed, 7),
  band: Schema.Literals(["wave", "dither", "none"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("wave" as const)),
  ),
  image: BackdropImageSettingsSchema.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type KaluwaBackdropSettings = typeof KaluwaBackdropSettingsSchema.Type;
export type BackdropPlacement = KaluwaBackdropSettings["placement"];
export type SidebarBand = KaluwaBackdropSettings["band"];

export const KALUWA_BACKDROP_STORAGE_KEY = "t3code:kaluwa-backdrop:v1";

/** Upstream look: no art, today's wave band. Every field still has the Ember tuning. */
export const DEFAULT_BACKDROP_SETTINGS: KaluwaBackdropSettings = Schema.decodeSync(
  KaluwaBackdropSettingsSchema,
)({});

/** The Kaluwa (-local) build starts on the Ember preset's horse over waves. */
const LOCAL_BACKDROP_SETTINGS: KaluwaBackdropSettings = {
  ...DEFAULT_BACKDROP_SETTINGS,
  art: "horse",
};

export const defaultBackdropSettings = (isLocalFlavour: boolean) =>
  isLocalFlavour ? LOCAL_BACKDROP_SETTINGS : DEFAULT_BACKDROP_SETTINGS;

export type BackdropView = "home" | "thread";

/** Opacity of the main-pane art, or 0 when it should not show at all. */
export function backdropOpacity(settings: KaluwaBackdropSettings, view: BackdropView): number {
  if (settings.art === "none") return 0;
  if (settings.placement === "home" && view !== "home") return 0;
  const base = settings.opacity / 100;
  return view === "home" ? base : base * (settings.inThreads / 100);
}

/** Drops an art choice whose uploaded image is gone, so the backdrop turns off cleanly. */
export function withAvailableArt(
  settings: KaluwaBackdropSettings,
  uploadIds: ReadonlySet<string> | null,
): KaluwaBackdropSettings {
  const uploadId = uploadIdOfArt(settings.art);
  if (uploadId !== null) {
    if (uploadIds === null || uploadIds.has(uploadId)) return settings;
    return { ...settings, art: "none" };
  }
  return settings.art === "none" || isGeneratedArt(settings.art)
    ? settings
    : { ...settings, art: "none" };
}
