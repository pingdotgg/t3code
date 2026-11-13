import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KeybindingShortcut } from "./keybindings.ts";
import { FILL_PREVIEW_VIEWPORT, PreviewViewportSetting } from "./preview.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;

export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const DiffLayout = Schema.Literals(["stacked", "split"]);
export type DiffLayout = typeof DiffLayout.Type;

export const DEFAULT_DIFF_LAYOUT: DiffLayout = "stacked";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;

export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;

export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const SidebarProjectGroupingMode = Schema.Literals([
  "repository",
  "repository_path",
  "separate",
]);
export type SidebarProjectGroupingMode = typeof SidebarProjectGroupingMode.Type;

export const DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE: SidebarProjectGroupingMode = "repository";

export const MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS = 1;

export const MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS = 90;

export const SidebarAutoSettleAfterDays = Schema.Number.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
    maximum: MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  }),
);
export type SidebarAutoSettleAfterDays = typeof SidebarAutoSettleAfterDays.Type;

export const DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS: SidebarAutoSettleAfterDays = 3;

export const MAX_SNOOZE_PRESET_MINUTES = 30 * 24 * 60;

export const MAX_SNOOZE_PRESETS = 8;

export const SnoozePresetDay = Schema.Literals([
  "today",
  "tomorrow",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);
export type SnoozePresetDay = typeof SnoozePresetDay.Type;

/** `after` wakes a fixed time from now. `at` wakes at a local time; a weekday is its next occurrence after today. */
export const SnoozePresetSetting = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("after"),
    minutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_SNOOZE_PRESET_MINUTES })),
  }),
  Schema.Struct({
    kind: Schema.Literal("at"),
    day: SnoozePresetDay,
    time: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/)),
  }),
]);
export type SnoozePresetSetting = typeof SnoozePresetSetting.Type;

export const SnoozePresetSettings = Schema.Array(SnoozePresetSetting).check(
  Schema.isMaxLength(MAX_SNOOZE_PRESETS),
);

export const DEFAULT_SNOOZE_PRESETS: ReadonlyArray<SnoozePresetSetting> = [
  { kind: "after", minutes: 60 },
  { kind: "after", minutes: 180 },
  { kind: "at", day: "today", time: "18:00" },
  { kind: "at", day: "tomorrow", time: "09:00" },
  { kind: "at", day: "monday", time: "09:00" },
];

export const MIN_GLASS_OPACITY = 40;

export const MAX_GLASS_OPACITY = 100;

export const GlassOpacity = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_GLASS_OPACITY,
    maximum: MAX_GLASS_OPACITY,
  }),
);
export type GlassOpacity = typeof GlassOpacity.Type;

export const DEFAULT_GLASS_OPACITY: GlassOpacity = 80;

export const MIN_APPEARANCE_CONTRAST = 50;

export const MAX_APPEARANCE_CONTRAST = 200;

export const AppearanceContrast = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_APPEARANCE_CONTRAST, maximum: MAX_APPEARANCE_CONTRAST }),
);
export type AppearanceContrast = typeof AppearanceContrast.Type;

export const DEFAULT_APPEARANCE_CONTRAST: AppearanceContrast = 100;

export const MIN_PANEL_ANIMATION_DURATION_MS = 0;

export const MAX_PANEL_ANIMATION_DURATION_MS = 400;

export const PanelAnimationDurationMs = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_PANEL_ANIMATION_DURATION_MS,
    maximum: MAX_PANEL_ANIMATION_DURATION_MS,
  }),
);
export type PanelAnimationDurationMs = typeof PanelAnimationDurationMs.Type;

export const DEFAULT_PANEL_ANIMATION_DURATION_MS: PanelAnimationDurationMs = 0;

export const MIN_INTERFACE_FONT_SIZE = 12;

export const MAX_INTERFACE_FONT_SIZE = 20;

export const InterfaceFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_INTERFACE_FONT_SIZE, maximum: MAX_INTERFACE_FONT_SIZE }),
);
export type InterfaceFontSize = typeof InterfaceFontSize.Type;

export const DEFAULT_INTERFACE_FONT_SIZE: InterfaceFontSize = 16;

export const MIN_PROMPT_FONT_SIZE = 12;

export const MAX_PROMPT_FONT_SIZE = 20;

export const PromptFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_PROMPT_FONT_SIZE, maximum: MAX_PROMPT_FONT_SIZE }),
);
export type PromptFontSize = typeof PromptFontSize.Type;

export const DEFAULT_PROMPT_FONT_SIZE: PromptFontSize = 14;

export const MIN_CODE_FONT_SIZE = 10;

export const MAX_CODE_FONT_SIZE = 18;

export const CodeFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_CODE_FONT_SIZE, maximum: MAX_CODE_FONT_SIZE }),
);
export type CodeFontSize = typeof CodeFontSize.Type;

export const DEFAULT_CODE_FONT_SIZE: CodeFontSize = 13;

export const MIN_TERMINAL_FONT_SIZE = 8;

export const MAX_TERMINAL_FONT_SIZE = 20;

export const TerminalFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_TERMINAL_FONT_SIZE, maximum: MAX_TERMINAL_FONT_SIZE }),
);
export type TerminalFontSize = typeof TerminalFontSize.Type;

export const DEFAULT_TERMINAL_FONT_SIZE: TerminalFontSize = 12;

// "artwork" follows the running channel and shows nothing on Latest. The fixed artwork
// modes let any channel opt into a specific channel's art.
export const EnvironmentIdentificationMode = Schema.Literals([
  "artwork",
  "nightly-artwork",
  "dev-artwork",
  "pill",
  "none",
]);
export type EnvironmentIdentificationMode = typeof EnvironmentIdentificationMode.Type;

export const DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE: EnvironmentIdentificationMode = "artwork";

export const SnapShotKeyChord = KeybindingShortcut.check(
  Schema.makeFilter(
    (shortcut) =>
      shortcut.metaKey ||
      shortcut.ctrlKey ||
      shortcut.shiftKey ||
      shortcut.altKey ||
      shortcut.modKey ||
      "Snapshot shortcut requires a modifier.",
  ),
);
export type SnapShotKeyChord = typeof SnapShotKeyChord.Type;

export const SNAP_SHOT_MODIFIERS = ["shift", "meta", "control", "alt"] as const;

export const SnapShotModifier = Schema.Literals(SNAP_SHOT_MODIFIERS);
export type SnapShotModifier = typeof SnapShotModifier.Type;

export const SnapShotShortcut = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("both-shift-keys") }),
  Schema.Struct({ kind: Schema.Literal("modifier-pair"), modifier: SnapShotModifier }),
  SnapShotKeyChord,
]);
export type SnapShotShortcut = typeof SnapShotShortcut.Type;

export const SnapShotSound = Schema.Literals(["soft-pop", "camera-shutter"]);
export type SnapShotSound = typeof SnapShotSound.Type;

export const DEFAULT_SNAP_SHOT_SOUND: SnapShotSound = "soft-pop";

export type SnapShotModifierPairShortcut = Extract<SnapShotShortcut, { readonly kind: string }>;

export function isModifierPairShortcut(
  shortcut: SnapShotShortcut,
): shortcut is SnapShotModifierPairShortcut {
  return "kind" in shortcut;
}

export function snapShotShortcutModifierPair(
  shortcut: SnapShotModifierPairShortcut,
): SnapShotModifier {
  return shortcut.kind === "both-shift-keys" ? "shift" : shortcut.modifier;
}

const APPLE_MODIFIER_LABELS: Record<SnapShotModifier, string> = {
  shift: "Shift",
  meta: "Command",
  control: "Control",
  alt: "Option",
};

const OTHER_MODIFIER_LABELS: Record<SnapShotModifier, string> = {
  shift: "Shift",
  meta: "Super",
  control: "Ctrl",
  alt: "Alt",
};

export function snapShotModifierPairLabel(modifier: SnapShotModifier, apple: boolean): string {
  const label = (apple ? APPLE_MODIFIER_LABELS : OTHER_MODIFIER_LABELS)[modifier];
  return `${label} + ${label}`;
}

export const DEFAULT_SNAP_SHOT_SHORTCUT: SnapShotShortcut = {
  kind: "both-shift-keys",
};

export const NotificationMode = Schema.Literals([
  "off",
  "notifications",
  "sound",
  "notifications-and-sound",
]);
export type NotificationMode = typeof NotificationMode.Type;

export const QuitConfirmationMode = Schema.Literals(["direct", "hold", "double-click"]);
export type QuitConfirmationMode = typeof QuitConfirmationMode.Type;

export const DEFAULT_QUIT_CONFIRMATION_MODE: QuitConfirmationMode = "hold";

const LegacyConfirmQuit = Schema.Boolean.pipe(
  Schema.decodeTo(
    QuitConfirmationMode,
    SchemaTransformation.transform({
      decode: (confirmQuit): QuitConfirmationMode => (confirmQuit ? "hold" : "direct"),
      encode: (mode) => mode === "hold",
    }),
  ),
);

export const QuitConfirmationModeSetting = Schema.Union([QuitConfirmationMode, LegacyConfirmQuit]);

export const FontFamilyPreference = Schema.String.check(Schema.isMaxLength(200));
export type FontFamilyPreference = typeof FontFamilyPreference.Type;

/** Clients apply each environment theme set once; later local choices persist until the next set. Empty clears it. */
export const DefaultThemePreference = Schema.String.check(Schema.isMaxLength(64));
// Excluded from RPC patches so t3 theme set can validate syntax and resolvability.
export type DefaultThemePreference = typeof DefaultThemePreference.Type;

export const DEFAULT_BROWSER_VIEWPORT: PreviewViewportSetting = FILL_PREVIEW_VIEWPORT;

export const DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW = true;

export const BrowserLinkTarget = Schema.Literals(["system", "app"]);
export type BrowserLinkTarget = typeof BrowserLinkTarget.Type;

export const DEFAULT_BROWSER_LINK_TARGET: BrowserLinkTarget = "system";

/**
 * What the address bar searches with when the input is not an address.
 * "custom" uses `browserCustomSearchUrl`, a template with `%s` for the query.
 */
export const BrowserSearchEngine = Schema.Literals([
  "duckduckgo",
  "google",
  "bing",
  "brave",
  "kagi",
  "ecosia",
  "custom",
]);
export type BrowserSearchEngine = typeof BrowserSearchEngine.Type;

export const DEFAULT_BROWSER_SEARCH_ENGINE: BrowserSearchEngine = "duckduckgo";

export const BROWSER_CUSTOM_SEARCH_URL_MAX_LENGTH = 2048;

export const BrowserCustomSearchUrl = Schema.String.check(
  Schema.isMaxLength(BROWSER_CUSTOM_SEARCH_URL_MAX_LENGTH),
);

export const LoadBalancingWeights = Schema.Record(
  TrimmedNonEmptyString,
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
);

export const DiffColorScheme = Schema.Literals(["red-green", "blue-orange"]);

export const ChatWidth = Schema.Literals(["comfortable", "wide", "full"]);
export type ChatWidth = typeof ChatWidth.Type;

/** How the composer shows reasoning effort: the level's name, or rising bars. */
export const EffortDisplay = Schema.Literals(["label", "bars"]);
export type EffortDisplay = typeof EffortDisplay.Type;

export const ModelFavorite = Schema.Struct({
  provider: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});

export const ModelFavorites = Schema.Array(ModelFavorite);

export const ProviderModelPreferences = Schema.Record(
  ProviderInstanceId,
  Schema.Struct({
    hiddenModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    modelOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
);

export type ModelPreferences = {
  readonly favorites: typeof ModelFavorites.Type;
  readonly providerModelPreferences: typeof ProviderModelPreferences.Type;
};
