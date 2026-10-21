import { EasDeviceHostConfigs, SshDeviceHostConfigs } from "./device.ts";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  ForwardCompatibleNullable,
  ForwardCompatibleOptional,
  OmittedWhenNull,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";
import { EnvironmentMachineKind, ThreadEnvMode, WorktreeSubmodules } from "./environment.ts";
import { KeybindingShortcut } from "./keybindings.ts";
import {
  CustomModelSetting,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  ProviderOptionSelections,
} from "./model.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectScript, type ProjectMutation } from "./project.ts";
import { DEFAULT_RUNTIME_MODE, RuntimeMode } from "./providerPolicy.ts";
import { BrowserProfile, BrowserProfileId, DEFAULT_BROWSER_PROFILE_ID } from "./browserProfile.ts";
import {
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  FILL_PREVIEW_VIEWPORT,
  PreviewAppearancePreference,
  PreviewViewportSetting,
  PreviewZoomFactor,
} from "./preview.ts";
import {
  ProviderInstanceConfig,
  ProviderInstanceId,
  ProviderDriverKind,
} from "./providerInstance.ts";
import { PullRequestMergeMethod } from "./pullRequest.ts";

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const DiffLayout = Schema.Literals(["stacked", "split"]);
export type DiffLayout = typeof DiffLayout.Type;
const DEFAULT_DIFF_LAYOUT: DiffLayout = "stacked";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const SidebarProjectGroupingMode = Schema.Literals([
  "repository",
  "repository_path",
  "separate",
]);
export type SidebarProjectGroupingMode = typeof SidebarProjectGroupingMode.Type;
const DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE: SidebarProjectGroupingMode = "repository";
export const MIN_SIDEBAR_THREAD_PREVIEW_COUNT = 1;
export const MAX_SIDEBAR_THREAD_PREVIEW_COUNT = 15;
export const SidebarThreadPreviewCount = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
    maximum: MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  }),
);
export type SidebarThreadPreviewCount = typeof SidebarThreadPreviewCount.Type;
const DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT: SidebarThreadPreviewCount = 6;
export const MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS = 1;
export const MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS = 90;
export const SidebarAutoSettleAfterDays = Schema.Number.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
    maximum: MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  }),
);
export type SidebarAutoSettleAfterDays = typeof SidebarAutoSettleAfterDays.Type;
const DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS: SidebarAutoSettleAfterDays = 3;
export const MIN_GLASS_OPACITY = 40;
export const MAX_GLASS_OPACITY = 100;
export const GlassOpacity = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_GLASS_OPACITY,
    maximum: MAX_GLASS_OPACITY,
  }),
);
export type GlassOpacity = typeof GlassOpacity.Type;
const DEFAULT_GLASS_OPACITY: GlassOpacity = 80;

export const MIN_APPEARANCE_CONTRAST = 50;
export const MAX_APPEARANCE_CONTRAST = 200;
export const AppearanceContrast = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_APPEARANCE_CONTRAST, maximum: MAX_APPEARANCE_CONTRAST }),
);
export type AppearanceContrast = typeof AppearanceContrast.Type;
const DEFAULT_APPEARANCE_CONTRAST: AppearanceContrast = 100;
export const MIN_PANEL_ANIMATION_DURATION_MS = 0;
export const MAX_PANEL_ANIMATION_DURATION_MS = 400;
export const PanelAnimationDurationMs = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_PANEL_ANIMATION_DURATION_MS,
    maximum: MAX_PANEL_ANIMATION_DURATION_MS,
  }),
);
export type PanelAnimationDurationMs = typeof PanelAnimationDurationMs.Type;
const DEFAULT_PANEL_ANIMATION_DURATION_MS: PanelAnimationDurationMs = 0;

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
const DEFAULT_TERMINAL_FONT_SIZE: TerminalFontSize = 12;

export const EnvironmentIdentificationMode = Schema.Literals(["artwork", "pill", "none"]);
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
const DEFAULT_SNAP_SHOT_SOUND: SnapShotSound = "soft-pop";

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
const DEFAULT_SNAP_SHOT_SHORTCUT: SnapShotShortcut = {
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
const DEFAULT_QUIT_CONFIRMATION_MODE: QuitConfirmationMode = "hold";

const LegacyConfirmQuit = Schema.Boolean.pipe(
  Schema.decodeTo(
    QuitConfirmationMode,
    SchemaTransformation.transform({
      decode: (confirmQuit): QuitConfirmationMode => (confirmQuit ? "hold" : "direct"),
      encode: (mode) => mode === "hold",
    }),
  ),
);

const QuitConfirmationModeSetting = Schema.Union([QuitConfirmationMode, LegacyConfirmQuit]);

export const FontFamilyPreference = Schema.String.check(Schema.isMaxLength(200));
export type FontFamilyPreference = typeof FontFamilyPreference.Type;

/**
 * The environment's theme, set with `t3 theme set <id>`. Each client applies
 * it once per value — live when connected, on its next connect otherwise — so
 * setting it switches every client, while a theme a user picks in Settings
 * afterwards sticks until the next set. Empty means "no environment theme",
 * which is also how it is cleared.
 */
export const DefaultThemePreference = Schema.String.check(Schema.isMaxLength(64));
// Deliberately absent from ServerSettingsPatch: `t3 theme set` checks that an
// id is syntactically valid and actually resolvable, and a generic RPC patch
// would let a client write a theme no client can resolve, bypassing both.
export type DefaultThemePreference = typeof DefaultThemePreference.Type;

export const DEFAULT_BROWSER_VIEWPORT: PreviewViewportSetting = FILL_PREVIEW_VIEWPORT;
export const DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW = true;
export const BROWSER_RECORDING_FRAME_RATES = [30, 60] as const;
export const BrowserRecordingFrameRate = Schema.Literals(BROWSER_RECORDING_FRAME_RATES);
export type BrowserRecordingFrameRate = typeof BrowserRecordingFrameRate.Type;
export const DEFAULT_BROWSER_RECORDING_FRAME_RATE: BrowserRecordingFrameRate = 30;
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

export const SidebarSide = Schema.Literals(["left", "right"]);
export type SidebarSide = typeof SidebarSide.Type;

export const ChatWidth = Schema.Literals(["comfortable", "wide", "full"]);
export type ChatWidth = typeof ChatWidth.Type;

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

export const ClientSettingsSchema = Schema.Struct({
  notificationMode: NotificationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("off" as const)),
  ),
  inAppNotificationsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  diffColorScheme: DiffColorScheme.pipe(
    Schema.withDecodingDefault(Effect.succeed("red-green" as const)),
  ),
  sidebarSide: SidebarSide.pipe(Schema.withDecodingDefault(Effect.succeed("left" as const))),
  chatWidth: ChatWidth.pipe(Schema.withDecodingDefault(Effect.succeed("comfortable" as const))),
  loadBalancingEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  loadBalancingWeights: LoadBalancingWeights.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  appearanceContrast: AppearanceContrast.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_APPEARANCE_CONTRAST)),
  ),
  // Panel motion defaults to zero because width and height transitions cause
  // layout work on every frame, which is noticeable on lower-power clients.
  panelAnimationDurationMs: PanelAnimationDurationMs.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PANEL_ANIMATION_DURATION_MS)),
  ),
  browserDefaultViewport: PreviewViewportSetting.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_VIEWPORT)),
  ),
  browserDefaultZoomFactor: PreviewZoomFactor.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PREVIEW_ZOOM_FACTOR)),
  ),
  browserDefaultAppearance: PreviewAppearancePreference.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PREVIEW_APPEARANCE)),
  ),
  browserRecordingFrameRate: BrowserRecordingFrameRate.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_RECORDING_FRAME_RATE)),
  ),
  browserRecordingShowKeyPresses: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  browserRecordingShowMousePresses: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),

  browserLinkTarget: BrowserLinkTarget.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_LINK_TARGET)),
  ),

  browserSearchEngine: BrowserSearchEngine.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_SEARCH_ENGINE)),
  ),

  // Kept when the engine is switched away from "custom" so switching back restores it.
  browserCustomSearchUrl: BrowserCustomSearchUrl.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),

  browserAutoShowFloatingPreview: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW)),
  ),

  browserProfiles: Schema.Array(BrowserProfile).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),

  browserDefaultProfileId: BrowserProfileId.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_PROFILE_ID)),
  ),

  confirmQuit: QuitConfirmationModeSetting.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_QUIT_CONFIRMATION_MODE)),
  ),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  confirmThreadUnpin: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  dismissedProviderUpdateNotificationKeys: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  diffFilesCollapsed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  diffIgnoreWhitespace: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  diffLayout: DiffLayout.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_DIFF_LAYOUT))),
  environmentIdentificationMode: EnvironmentIdentificationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE)),
  ),
  glassOpacity: GlassOpacity.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_GLASS_OPACITY)),
  ),
  fontSizeInterface: InterfaceFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_INTERFACE_FONT_SIZE)),
  ),
  fontSizePrompt: PromptFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROMPT_FONT_SIZE)),
  ),
  fontSizeCode: CodeFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CODE_FONT_SIZE)),
  ),
  fontSizeTerminal: TerminalFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TERMINAL_FONT_SIZE)),
  ),
  fontFamilyCode: FontFamilyPreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  fontFamilyComposer: FontFamilyPreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  fontFamilySans: FontFamilyPreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  fontFamilyTerminal: FontFamilyPreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),

  fontSmoothing: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // `null` alone does not mean "show the wizard" — every install that predates
  // this field decodes to `null` — so the gate also requires an empty workspace
  // before it treats the client as a fresh install.
  onboardingCompletedAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  persistComposerContextStrip: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),

  favorites: ModelFavorites.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  providerModelPreferences: ProviderModelPreferences.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  pullRequestMergeMethodOverrides: Schema.Record(
    TrimmedNonEmptyString,
    PullRequestMergeMethod,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),

  pullRequestLinksOpenInApp: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),

  planModeEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  contextWindowMeterEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  composerCollapseOnScroll: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  composerRichTextEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sendShortcut: Schema.Literals(["enter", "mod-enter-multiline", "mod-enter"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("enter")),
  ),
  followUpBehavior: Schema.Literals(["queue", "steer"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("queue")),
  ),
  proactivePanelsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  showSkillsInSlashMenu: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  legacySidebarEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  sidebarWorkingShelfEnabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  sidebarProjectGroupingMode: SidebarProjectGroupingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE)),
  ),
  sidebarProjectGroupingOverrides: Schema.Record(
    TrimmedNonEmptyString,
    SidebarProjectGroupingMode,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER)),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_SORT_ORDER)),
  ),
  sidebarThreadPreviewCount: SidebarThreadPreviewCount.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT)),
  ),
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
  snapShotEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  snapShotIncludeAccessibility: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  snapShotShortcut: SnapShotShortcut.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SNAP_SHOT_SHORTCUT)),
  ),
  snapShotPlaySound: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  snapShotSound: SnapShotSound.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SNAP_SHOT_SOUND)),
  ),
  snapShotFlash: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  snapShotAnimations: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  wordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Opt-in TeX typesetting in rendered Markdown. Off keeps math parsing and
  // KaTeX out of the render path entirely.
  mathRenderingEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

const UsageModelTokenPrice = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
);

/** Omitted cache rates use the input rate. */
export const UsageModelPriceOverride = Schema.Struct({
  inputCostPerMillionTokens: UsageModelTokenPrice,
  outputCostPerMillionTokens: UsageModelTokenPrice,
  cacheReadCostPerMillionTokens: Schema.optionalKey(UsageModelTokenPrice),
  cacheWriteCostPerMillionTokens: Schema.optionalKey(UsageModelTokenPrice),
});
export type UsageModelPriceOverride = typeof UsageModelPriceOverride.Type;

export const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformEffect({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export type ProviderSettingsFormControl = "text" | "password" | "textarea" | "switch" | "select";

export interface ProviderSettingsFormOption {
  readonly value: string;
  readonly label: string;
}

export interface ProviderSettingsFormAnnotation {
  readonly control?: ProviderSettingsFormControl | undefined;
  readonly placeholder?: string | undefined;
  readonly hidden?: boolean | undefined;
  readonly clearWhenEmpty?: "omit" | "persist" | undefined;

  readonly options?: ReadonlyArray<ProviderSettingsFormOption> | undefined;
}

export function secretSettingsFields(schema: {
  readonly fields: Readonly<Record<string, Schema.Top>>;
}): ReadonlyArray<string> {
  return Object.entries(schema.fields).flatMap(([field, fieldSchema]) => {
    return isSecretSetting(fieldSchema) ? [field] : [];
  });
}

export interface ProviderSettingsFormSchemaAnnotation {
  readonly order?: readonly string[] | undefined;
}

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      /** Store this credential separately and expose only whether it is configured to clients. */
      readonly settingsSecret?: boolean | undefined;
      readonly providerSettingsForm?: ProviderSettingsFormAnnotation | undefined;
      readonly providerSettingsFormSchema?: ProviderSettingsFormSchemaAnnotation | undefined;
    }
  }
}

export function secretSetting<S extends Schema.Top>(schema: S): S["Rebuild"] {
  return schema.annotateKey({ settingsSecret: true });
}

/** A masked form field is a credential too, so none is saved or sent to clients as plain text. */
export function isSecretSetting(schema: Schema.Top): boolean {
  const annotations = Schema.resolveAnnotationsKey(schema) ?? Schema.resolveAnnotations(schema);
  return (
    annotations?.settingsSecret === true ||
    annotations?.providerSettingsForm?.control === "password"
  );
}

export type ProviderSettingsOrder<Fields extends Schema.Struct.Fields> = readonly Extract<
  keyof Fields,
  string
>[];

export function makeProviderSettingsSchema<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
  options?: {
    readonly order?: ProviderSettingsOrder<Fields> | undefined;
  },
): Schema.Struct<Fields> {
  return Schema.Struct(fields).pipe(
    Schema.annotate({
      providerSettingsFormSchema:
        options?.order === undefined ? undefined : { order: options.order },
    }),
  );
}

export const CodexSettings = makeProviderSettingsSchema(
  {
    setupMode: Schema.optionalKey(Schema.Literals(["managed", "existing"])).pipe(
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("codex").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Codex binary used by this instance.",
        providerSettingsForm: { placeholder: "codex", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CODEX_HOME path",
        description: "Custom Codex home and config directory.",
        providerSettingsForm: {
          placeholder: "~/.codex",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    shadowHomePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Shadow home path",
        description:
          "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.",
        providerSettingsForm: {
          placeholder: "~/.codex-t3/personal",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed to codex app-server on session start.",
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "shadowHomePath", "launchArgs"],
  },
);
export type CodexSettings = typeof CodexSettings.Type;

const CLAUDE_AUTO_COMPACT_WINDOW_PATTERN = /^(?:|[1-9]\d{5}|1000000)$/;

export const ClaudeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("claude").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Claude binary used by this instance.",
        providerSettingsForm: { placeholder: "claude", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CLAUDE_CONFIG_DIR path",
        description:
          "Custom Claude home and config directory. Keeps .claude.json and .claude separate.",
        providerSettingsForm: { placeholder: "~/.claude", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    launchArgs: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed on session start.",
        providerSettingsForm: {
          placeholder: "e.g. --chrome",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    autoCompactWindow: TrimmedString.check(
      Schema.isPattern(CLAUDE_AUTO_COMPACT_WINDOW_PATTERN),
    ).pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Auto-compact after",
        description:
          "Compact after 100,000 to 1,000,000 tokens. Leave empty to use Claude's default.",
        providerSettingsForm: {
          placeholder: "e.g. 300000",
          clearWhenEmpty: "omit",
        },
      }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "autoCompactWindow", "launchArgs"],
  },
);
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const ANTIGRAVITY_AUTH_METHODS = [
  { value: "oauth-personal", label: "Google account" },
  { value: "oauth-business", label: "Gemini Enterprise" },
  { value: "gemini-api-key", label: "Gemini API key" },
  { value: "agent-platform", label: "Agent Platform (Vertex AI)" },
] as const satisfies ReadonlyArray<ProviderSettingsFormOption>;
export const AntigravityAuthMethod = Schema.Literals(
  ANTIGRAVITY_AUTH_METHODS.map((method) => method.value),
);
export type AntigravityAuthMethod = typeof AntigravityAuthMethod.Type;

export const AntigravitySettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    authMethod: AntigravityAuthMethod.pipe(
      Schema.withDecodingDefault(Effect.succeed("oauth-personal" as const)),
      Schema.annotateKey({
        title: "Sign-in method",
        description:
          "Google accounts use your subscription; API keys and Agent Platform bill usage.",
        providerSettingsForm: {
          control: "select",
          options: ANTIGRAVITY_AUTH_METHODS,
          clearWhenEmpty: "omit",
        },
      }),
    ),
    apiKey: TrimmedString.pipe(
      secretSetting,
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API key",
        description: "Gemini or Vertex AI express key. Stored separately on the host.",
        providerSettingsForm: {
          control: "password",
          placeholder: "Optional",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    gcpProject: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "GCP project",
        description:
          "Required for Gemini Enterprise. Agent Platform uses it when no API key is set.",
        providerSettingsForm: { placeholder: "my-project-id", clearWhenEmpty: "omit" },
      }),
    ),
    gcpLocation: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "GCP location",
        description: "Region for Gemini Enterprise or Agent Platform.",
        providerSettingsForm: { placeholder: "us-central1", clearWhenEmpty: "omit" },
      }),
    ),
    binaryPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Binary path",
        description: "Custom ACP executable. Leave empty to select automatically.",
        providerSettingsForm: { placeholder: "Automatic", clearWhenEmpty: "persist" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  { order: ["authMethod", "apiKey", "gcpProject", "gcpLocation", "binaryPath"] },
);
export type AntigravitySettings = typeof AntigravitySettings.Type;

export const UsageLimitSourceConfig = Schema.Struct({
  kind: Schema.Literal("cliproxy"),
  label: Schema.optional(TrimmedNonEmptyString),
  url: TrimmedNonEmptyString,
  managementKey: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed("")), secretSetting),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type UsageLimitSourceConfig = typeof UsageLimitSourceConfig.Type;

export const GitHubHost = TrimmedNonEmptyString.pipe(
  Schema.decodeTo(Schema.String, SchemaTransformation.toLowerCase()),
);

export const SourceControlHostSettings = Schema.Record(Schema.String, Schema.Unknown);
export type SourceControlHostSettings = typeof SourceControlHostSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpLogsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const SourceControlWritingStyleMode = Schema.Literals([
  "repo_conventions",
  "conventional_commits",
  "custom",
]);
export type SourceControlWritingStyleMode = typeof SourceControlWritingStyleMode.Type;

export const SourceControlWritingStyleSettings = Schema.Struct({
  mode: SourceControlWritingStyleMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("repo_conventions" as const)),
  ),
  customInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  followChangeRequestTemplates: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
});
export type SourceControlWritingStyleSettings = typeof SourceControlWritingStyleSettings.Type;

const LegacySourceControlWritingStyle = TrimmedString.pipe(
  Schema.decodeTo(
    Schema.toType(SourceControlWritingStyleSettings),
    SchemaTransformation.transform({
      decode: (value): SourceControlWritingStyleSettings => ({
        mode: value.length > 0 ? "custom" : "repo_conventions",
        customInstructions: value,
        followChangeRequestTemplates: true,
      }),
      encode: (value) => value.customInstructions,
    }),
  ),
);

// The struct member comes first so encoding uses its defaulted fields: the server strips
// default sub-fields before writing settings.json, and a toType target would reject them.
const SourceControlWritingStyleSetting = Schema.Union([
  SourceControlWritingStyleSettings,
  LegacySourceControlWritingStyle,
]);

export const BranchNamingMode = Schema.Literals(["static", "semantic", "custom"]);
export type BranchNamingMode = typeof BranchNamingMode.Type;

export interface BranchNamingOptions {
  mode: BranchNamingMode;
  prefix: string;
  instructions: string;
}

export const DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL = Duration.seconds(30);
export const DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL = Duration.minutes(5);

export const BackgroundActivityProfile = Schema.Literals([
  "balanced",
  "performance",
  "battery-saver",
]);
export type BackgroundActivityProfile = typeof BackgroundActivityProfile.Type;
export const DEFAULT_BACKGROUND_ACTIVITY_PROFILE: BackgroundActivityProfile = "balanced";

export const BackgroundActivityProfileSelection = Schema.Literals([
  "balanced",
  "performance",
  "battery-saver",
  "custom",
]);
export type BackgroundActivityProfileSelection = typeof BackgroundActivityProfileSelection.Type;

export const BackgroundActivityOverrides = Schema.Struct({
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  hostPowerMonitorActiveInterval: Schema.optionalKey(Schema.DurationFromMillis),
  hostPowerMonitorIdleInterval: Schema.optionalKey(Schema.DurationFromMillis),
  idleClientTtl: Schema.optionalKey(Schema.DurationFromMillis),
  pauseWhenHostLocked: Schema.optionalKey(Schema.Boolean),
  pauseWhenHostLowPower: Schema.optionalKey(Schema.Boolean),
  pauseWhenClientLowPower: Schema.optionalKey(Schema.Boolean),
  pauseWhenOnBattery: Schema.optionalKey(Schema.Boolean),
});
export type BackgroundActivityOverrides = typeof BackgroundActivityOverrides.Type;

export const BackgroundActivitySettings = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
  profile: BackgroundActivityProfileSelection.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  baseProfile: Schema.optionalKey(BackgroundActivityProfile),
  overrides: BackgroundActivityOverrides.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type BackgroundActivitySettings = typeof BackgroundActivitySettings.Type;

export const ResponseStreamingMode = Schema.Literals(["turn", "paragraph"]);
export type ResponseStreamingMode = typeof ResponseStreamingMode.Type;

const StorageRetentionDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 })),
);
const SettledWorktreeRetentionDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3650 })),
);

export const WorktreeKeepWhen = Schema.Literals([
  "any-local-files",
  "uncommitted-changes",
  "tracked-changes",
]);
export type WorktreeKeepWhen = typeof WorktreeKeepWhen.Type;

export const WorktreeCleanupRules = Schema.Struct({
  worktreeKeepWhen: WorktreeKeepWhen.pipe(
    Schema.withDecodingDefault(Effect.succeed("uncommitted-changes")),
  ),
  worktreeAfterDays: StorageRetentionDays,
  worktreeSettledAfterDays: SettledWorktreeRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  worktreeOnMerge: Schema.Boolean,
  worktreeOnDelete: Schema.Boolean,
  worktreeUnchanged: Schema.Boolean,
});
export type WorktreeCleanupRules = typeof WorktreeCleanupRules.Type;

export const WorktreeCleanup = Schema.NullOr(
  Schema.Union([
    Schema.Struct({ mode: Schema.Literal("off") }),
    Schema.Struct({ mode: Schema.Literal("custom"), rules: WorktreeCleanupRules }),
  ]),
);
export type WorktreeCleanup = typeof WorktreeCleanup.Type;

export const PROJECT_SCOPED_SERVER_SETTING_KEYS = [
  "worktreeCleanup",
  "defaultModelSelection",
  "defaultRuntimeMode",
  "defaultThreadEnvMode",
  "newWorktreesStartFromOrigin",
  "worktreeSubmodules",
  "defaultAutoPull",
  "defaultProjectScripts",
  "enableAgentBrowserAccess",
  "enableAgentDeviceAccess",
  "textGenerationModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "reviewGuideInstructions",
  "sourceControlWritingStyle",
  "removeAgentCreditsOnMerge",
  "branchNamingMode",
  "branchNamePrefix",
  "branchNameInstructions",
  "pullRequestMergeMethod",
  "sidebarAutoSettleOnMerge",
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleKeepPullRequests",
  "continueThreadsAfterServerUpdate",
  "responseStreamingMode",
] as const;
export type ProjectScopedServerSettingKey = (typeof PROJECT_SCOPED_SERVER_SETTING_KEYS)[number];

export const ProjectProviderInstanceOverride = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type ProjectProviderInstanceOverride = typeof ProjectProviderInstanceOverride.Type;

/**
 * An absent key inherits the environment value; `null` is a real value where
 * the environment type is nullable (no default model, no dedicated writer
 * model, never auto-settle).
 *
 * `providerInstances` sits outside `PROJECT_SCOPED_SERVER_SETTING_KEYS`: every
 * other key replaces its `ServerSettings` field whole, while this one keeps the
 * settings.json shape but overrides field by field, per `ProviderInstanceId`.
 */
export const ProjectSettingsOverrides = Schema.Struct({
  worktreeCleanup: Schema.optionalKey(WorktreeCleanup),
  defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  defaultRuntimeMode: Schema.optionalKey(RuntimeMode),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  worktreeSubmodules: ForwardCompatibleOptional(WorktreeSubmodules),
  defaultAutoPull: Schema.optionalKey(Schema.Boolean),
  defaultProjectScripts: Schema.optionalKey(Schema.Array(ProjectScript)),
  enableAgentBrowserAccess: Schema.optionalKey(Schema.Boolean),
  enableAgentDeviceAccess: Schema.optionalKey(Schema.Boolean),
  textGenerationModelSelection: Schema.optionalKey(ModelSelection),
  sourceControlWriterModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  reviewGuideModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  reviewGuideInstructions: Schema.optionalKey(TrimmedString),
  sourceControlWritingStyle: Schema.optionalKey(SourceControlWritingStyleSetting),
  removeAgentCreditsOnMerge: Schema.optionalKey(Schema.Boolean),
  branchNamingMode: Schema.optionalKey(BranchNamingMode),
  branchNamePrefix: Schema.optionalKey(TrimmedString),
  branchNameInstructions: Schema.optionalKey(TrimmedString),
  pullRequestMergeMethod: Schema.optionalKey(Schema.NullOr(PullRequestMergeMethod)),
  sidebarAutoSettleOnMerge: Schema.optionalKey(Schema.Boolean),
  sidebarAutoSettleAfterDays: Schema.optionalKey(Schema.NullOr(SidebarAutoSettleAfterDays)),
  sidebarAutoSettleKeepPullRequests: Schema.optionalKey(Schema.Boolean),
  continueThreadsAfterServerUpdate: Schema.optionalKey(Schema.Boolean),
  responseStreamingMode: Schema.optionalKey(ResponseStreamingMode),
  providerInstances: Schema.optionalKey(
    Schema.Record(ProviderInstanceId, ProjectProviderInstanceOverride),
  ),
} satisfies Record<ProjectScopedServerSettingKey | "providerInstances", unknown>);
export type ProjectSettingsOverrides = typeof ProjectSettingsOverrides.Type;

/**
 * Whether `null` is a stored override value for this key rather than "unset".
 * Clients writing a project override treat null for every other key as a
 * request to remove the override, so a picker's "Inherit" item and the row's
 * reset do the same thing.
 */
export function isNullableProjectSettingsOverride(key: ProjectScopedServerSettingKey): boolean {
  return NULLABLE_PROJECT_SETTINGS_OVERRIDES.has(key);
}
const NULLABLE_PROJECT_SETTINGS_OVERRIDES: ReadonlySet<ProjectScopedServerSettingKey> = new Set<
  {
    [K in ProjectScopedServerSettingKey]: null extends ProjectSettingsOverrides[K] ? K : never;
  }[ProjectScopedServerSettingKey]
>([
  "defaultModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "pullRequestMergeMethod",
  "sidebarAutoSettleAfterDays",
]);

/** Reclaimable bytes from which the offline `t3 doctor` repair is worth suggesting. */
export const DATABASE_COMPACTION_RECOMMENDED_BYTES = 1024 ** 3;

/** Live SQLite file accounting for the environment's state database. */
export const DatabaseStorageStatus = Schema.Struct({
  databaseBytes: Schema.Number,
  /** Free pages inside the file that an offline VACUUM (or incremental auto_vacuum) returns to disk. */
  reclaimableBytes: Schema.Number,
  /** False on databases created before incremental auto_vacuum; `t3 doctor` converts them. */
  incrementalVacuumEnabled: Schema.Boolean,
  /** Command to run on the host to reclaim the space offline. */
  compactCommand: Schema.String,
});
export type DatabaseStorageStatus = typeof DatabaseStorageStatus.Type;

/** Only suggest the offline conversion when it can reclaim enough to matter. */
export function shouldRecommendDatabaseCompaction(status: DatabaseStorageStatus): boolean {
  return (
    !status.incrementalVacuumEnabled &&
    status.reclaimableBytes >= DATABASE_COMPACTION_RECOMMENDED_BYTES
  );
}

export const StorageCleanupReportEntry = Schema.Struct({
  kind: Schema.Literals(["worktree", "browser-artifacts", "logs"]),
  outcome: Schema.Literals(["removed", "kept", "failed"]),
  reason: Schema.String,
  path: Schema.NullOr(Schema.String),
  projectPath: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  threadId: Schema.NullOr(ThreadId),
  threadTitle: Schema.NullOr(Schema.String),
  bytes: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  files: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type StorageCleanupReportEntry = typeof StorageCleanupReportEntry.Type;
export const StorageCleanupReport = Schema.Struct({
  trigger: Schema.Literals(["automatic", "manual"]),
  startedAt: Schema.String,
  finishedAt: Schema.String,
  entries: Schema.Array(StorageCleanupReportEntry),
  counts: Schema.Struct({ removed: Schema.Number, kept: Schema.Number, failed: Schema.Number }),
  omittedCount: Schema.Number,
  bytesFreed: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
export type StorageCleanupReport = typeof StorageCleanupReport.Type;

export const StorageCleanupSettings = Schema.Struct({
  worktreeKeepWhen: WorktreeKeepWhen.pipe(
    Schema.withDecodingDefault(Effect.succeed("uncommitted-changes")),
  ),
  worktreeAfterDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  worktreeSettledAfterDays: SettledWorktreeRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  worktreeOnMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeOnDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeUnchanged: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  browserArtifactsAfterDays: StorageRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  logsAfterDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type StorageCleanupSettings = typeof StorageCleanupSettings.Type;

export const ServerSettings = Schema.Struct({
  // Null means no client has migrated this preference yet; an empty value is
  // authoritative so another device cannot resurrect cleared preferences.
  favorites: Schema.NullOr(ModelFavorites).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  providerModelPreferences: Schema.NullOr(ProviderModelPreferences).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  worktreeCleanup: WorktreeCleanup.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  storageCleanup: StorageCleanupSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(Schema.decodeSync(StorageCleanupSettings)({}))),
  ),

  worktreesDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /**
   * Custom locations used before the current one. Server-maintained so
   * worktrees left there stay eligible for cleanup and review diffs.
   */
  previousWorktreesDirectories: Schema.Array(TrimmedString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  responseStreamingMode: ResponseStreamingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("paragraph" as const)),
  ),
  enableProviderUpdateChecks: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  continueThreadsAfterServerUpdate: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),

  enableAgentBrowserAccess: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  projectAgentBrowserAccessOverrides: Schema.Record(ProjectId, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  defaultAutoPull: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  defaultProjectScripts: Schema.Array(ProjectScript).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  projectScriptOverrides: Schema.Record(ProjectId, Schema.NullOr(Schema.Array(ProjectScript))).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  projectAutoPullOverrides: Schema.Record(ProjectId, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  defaultModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  defaultRuntimeMode: RuntimeMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE)),
  ),

  projectSettingsOverrides: Schema.Record(ProjectId, ProjectSettingsOverrides).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /**
   * The fold runs once so a later reset in the settings UI is not undone by the
   * next server start.
   */
  projectSettingsFolded: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),

  enableAgentDeviceAccess: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Kept separate from agent access so enabling the user's Device panel does
   * not also grant providers control of simulators and emulators.
   */
  enableDeviceSupport: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  deviceOnboardingCompleted: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  deviceHosts: SshDeviceHostConfigs.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  easDeviceHosts: EasDeviceHostConfigs.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  sidebarAutoSettleAfterDays: Schema.NullOr(SidebarAutoSettleAfterDays).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS)),
  ),
  compactIdleThreads: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  snoozeLimitedThreads: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  autoResumeLimitedThreads: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  sidebarAutoSettleKeepPullRequests: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  sidebarAutoSettleOnMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  backgroundActivity: BackgroundActivitySettings,

  automaticGitFetchInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
    ),
  ),
  providerHealthRefreshInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL)),
    ),
  ),
  backgroundActivityProfile: BackgroundActivityProfile.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  defaultTheme: DefaultThemePreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /**
   * When the environment's theme was last set, so clients can tell a re-set of
   * the same value from one they already applied: `t3 theme set` must act even
   * when it names the theme it named before.
   */
  defaultThemeSetAt: Schema.String.check(Schema.isMaxLength(64)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
  environmentIcon: ForwardCompatibleNullable(EnvironmentMachineKind).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * Null means inherit: the repository's t3.json, then "local". Null stays off the wire
   * so older clients, which require a literal here, keep decoding.
   */
  defaultThreadEnvMode: OmittedWhenNull(ThreadEnvMode),
  newWorktreesStartFromOrigin: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  /**
   * Null defers to the repository's t3.json, then to recursive. A value
   * picked on a newer server decodes as null here rather than failing the
   * whole settings snapshot for an older client.
   */
  worktreeSubmodules: ForwardCompatibleNullable(WorktreeSubmodules).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_TEXT_GENERATION_MODEL,
        options: [
          {
            id: "reasoningEffort",
            value: DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
          },
        ],
      }),
    ),
  ),
  branchNamingMode: BranchNamingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("static" as const)),
  ),
  branchNamePrefix: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed("t3"))),
  branchNameInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  removeAgentCreditsOnMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  sourceControlWritingStyle: SourceControlWritingStyleSetting.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  sourceControlWriterModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  reviewGuidesEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  reviewGuideModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  reviewGuideInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),

  pullRequestMergeMethod: Schema.NullOr(PullRequestMergeMethod).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),

  // The driver-specific config blob is `Schema.Unknown` at this layer so
  // envelopes with unknown drivers (forks, downgrades, in-flight PR branches)
  // round-trip without loss. See providerInstance.ts for the forward/backward
  // compatibility invariant.
  providerInstances: Schema.Record(ProviderInstanceId, ProviderInstanceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sourceControlHosts: Schema.Record(Schema.String, SourceControlHostSettings).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  // Keyed by a user-chosen id so a source keeps its rows across edits. Entries
  // this build cannot decode round-trip untouched, as provider instances do.
  usageLimitSources: Schema.Record(UsageLimitSourceId, UsageLimitSourceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  cursorKeychainUsageEnabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),

  usagePriceOverrides: Schema.Record(TrimmedNonEmptyString, UsageModelPriceOverride).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),

  usageModelAliases: Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export const providerInstanceConfigEnabledFlag = (config: unknown): boolean | undefined => {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }
  const enabled = (config as { readonly enabled?: unknown }).enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
};

/**
 * Matches the `enabled` decoding default of each driver's settings schema.
 */
const DEFAULT_DISABLED_PROVIDER_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set(
  ["cursor", "grok", "muse", "pi", "opencode", "antigravity"].map((driver) =>
    ProviderDriverKind.make(driver),
  ),
);

const DEFAULT_ENABLED_DEFAULT_INSTANCES: ReadonlySet<ProviderInstanceId> = new Set(
  ["codex", "claudeAgent"].map((instanceId) => ProviderInstanceId.make(instanceId)),
);

export const isUnconfiguredDefaultInstanceEnabled = (instanceId: ProviderInstanceId): boolean =>
  DEFAULT_ENABLED_DEFAULT_INSTANCES.has(instanceId);

const defaultEnabledForDriver = (driver: ProviderDriverKind): boolean =>
  !DEFAULT_DISABLED_PROVIDER_DRIVERS.has(driver);

export const resolveProviderInstanceEnabled = (
  instance: Pick<ProviderInstanceConfig, "driver" | "enabled" | "config">,
): boolean => {
  const configEnabled = providerInstanceConfigEnabledFlag(instance.config);
  if (instance.enabled === false || configEnabled === false) {
    return false;
  }
  return instance.enabled ?? configEnabled ?? defaultEnabledForDriver(instance.driver);
};

export const resolveProjectProviderInstanceEnabled = (
  settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">,
  projectId: ProjectId | null,
  instanceId: ProviderInstanceId,
): boolean => {
  const override =
    projectId === null
      ? undefined
      : settings.projectSettingsOverrides[projectId]?.providerInstances?.[instanceId]?.enabled;
  if (override !== undefined) return override;
  const instanceConfig = Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId]
    : undefined;
  return instanceConfig !== undefined
    ? resolveProviderInstanceEnabled(instanceConfig)
    : isUnconfiguredDefaultInstanceEnabled(instanceId);
};

export const ServerSettingsOperation = Schema.Literals([
  "normalize",
  "check-exists",
  "create-provider-instance",
  "read-file",
  "read-provider-history",
  "read-project-settings",
  "read-secret",
  "remove-secret",
  "remove-stale-secret",
  "write-secret",
  "write-file",
  "prepare-directory",
]);
export type ServerSettingsOperation = typeof ServerSettingsOperation.Type;

export class ServerSettingsError extends Schema.TaggedError<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    operation: ServerSettingsOperation,
    providerInstanceId: Schema.optional(Schema.String),
    environmentVariable: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const provider =
      this.providerInstanceId === undefined ? "" : ` for provider ${this.providerInstanceId}`;
    const variable =
      this.environmentVariable === undefined
        ? ""
        : ` and environment variable ${this.environmentVariable}`;
    return `Server settings ${this.operation} failed${provider}${variable} at ${this.settingsPath}.`;
  }
}

export type UnifiedSettings = Omit<ServerSettings, keyof ModelPreferences> & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

const ModelSelectionPatch = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});

export const ServerSettingsPatch = Schema.Struct({
  setModelFavorites: Schema.optionalKey(
    Schema.Array(Schema.Struct({ ...ModelFavorite.fields, favorite: Schema.Boolean })),
  ),
  setModelsHidden: Schema.optionalKey(
    Schema.Array(Schema.Struct({ ...ModelFavorite.fields, hidden: Schema.Boolean })),
  ),
  setProviderModelOrder: Schema.optionalKey(
    Schema.Struct({ provider: ProviderInstanceId, modelOrder: Schema.Array(TrimmedString) }),
  ),
  favorites: Schema.optionalKey(ModelFavorites),
  providerModelPreferences: Schema.optionalKey(ProviderModelPreferences),
  // Applied under the settings service's write lock, only while still unset.
  migrateModelPreferences: Schema.optionalKey(
    Schema.Struct({
      favorites: Schema.optionalKey(ModelFavorites),
      providerModelPreferences: Schema.optionalKey(ProviderModelPreferences),
    }),
  ),
  worktreeCleanup: Schema.optionalKey(
    Schema.NullOr(
      Schema.Union([
        Schema.Struct({ mode: Schema.Literal("off") }),
        Schema.Struct({
          mode: Schema.Literal("custom"),
          rules: Schema.Struct({
            worktreeKeepWhen: Schema.optionalKey(WorktreeKeepWhen),
            worktreeAfterDays: Schema.optionalKey(StorageRetentionDays),
            worktreeSettledAfterDays: Schema.optionalKey(SettledWorktreeRetentionDays),
            worktreeOnMerge: Schema.optionalKey(Schema.Boolean),
            worktreeOnDelete: Schema.optionalKey(Schema.Boolean),
            worktreeUnchanged: Schema.optionalKey(Schema.Boolean),
          }),
        }),
      ]),
    ),
  ),
  storageCleanup: Schema.optionalKey(
    Schema.Struct({
      worktreeKeepWhen: Schema.optionalKey(WorktreeKeepWhen),
      worktreeAfterDays: Schema.optionalKey(StorageRetentionDays),
      worktreeSettledAfterDays: Schema.optionalKey(SettledWorktreeRetentionDays),
      worktreeOnMerge: Schema.optionalKey(Schema.Boolean),
      worktreeOnDelete: Schema.optionalKey(Schema.Boolean),
      worktreeUnchanged: Schema.optionalKey(Schema.Boolean),
      browserArtifactsAfterDays: Schema.optionalKey(StorageRetentionDays),
      logsAfterDays: Schema.optionalKey(StorageRetentionDays),
    }),
  ),
  worktreesDirectory: Schema.optionalKey(TrimmedString),
  responseStreamingMode: Schema.optionalKey(ResponseStreamingMode),
  enableProviderUpdateChecks: Schema.optionalKey(Schema.Boolean),
  continueThreadsAfterServerUpdate: Schema.optionalKey(Schema.Boolean),
  enableAgentBrowserAccess: Schema.optionalKey(Schema.Boolean),
  projectAgentBrowserAccessOverrides: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(Schema.Boolean)),
  ),
  defaultAutoPull: Schema.optionalKey(Schema.Boolean),
  defaultProjectScripts: Schema.optionalKey(Schema.Array(ProjectScript)),
  projectScriptOverrides: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(Schema.Array(ProjectScript))),
  ),
  projectAutoPullOverrides: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(Schema.Boolean)),
  ),
  defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  defaultRuntimeMode: Schema.optionalKey(RuntimeMode),
  /**
   * Per-project entry replacement: each entry replaces that project's whole
   * override set and `null` removes it.
   *
   * `providerInstances` is the one exception: an entry that omits the key keeps
   * the stored value instead of clearing it, so a client built before that
   * field existed cannot wipe it by editing another key.
   */
  projectSettingsOverrides: Schema.optionalKey(
    Schema.Record(
      ProjectId,
      Schema.NullOr(
        Schema.Struct({
          ...ProjectSettingsOverrides.fields,
          sourceControlWritingStyle: Schema.optionalKey(SourceControlWritingStyleSettings),
        }),
      ),
    ),
  ),
  enableAgentDeviceAccess: Schema.optionalKey(Schema.Boolean),
  enableDeviceSupport: Schema.optionalKey(Schema.Boolean),
  deviceOnboardingCompleted: Schema.optionalKey(Schema.Boolean),
  deviceHosts: Schema.optionalKey(SshDeviceHostConfigs),
  easDeviceHosts: Schema.optionalKey(EasDeviceHostConfigs),
  sidebarAutoSettleAfterDays: Schema.optionalKey(Schema.NullOr(SidebarAutoSettleAfterDays)),
  compactIdleThreads: Schema.optionalKey(Schema.Boolean),
  sidebarAutoSettleKeepPullRequests: Schema.optionalKey(Schema.Boolean),
  sidebarAutoSettleOnMerge: Schema.optionalKey(Schema.Boolean),
  autoResumeLimitedThreads: Schema.optionalKey(Schema.Boolean),
  snoozeLimitedThreads: Schema.optionalKey(Schema.Boolean),
  backgroundActivity: Schema.optionalKey(
    Schema.Struct({
      schemaVersion: Schema.optionalKey(Schema.Literal(1)),
      profile: Schema.optionalKey(BackgroundActivityProfileSelection),
      baseProfile: Schema.optionalKey(BackgroundActivityProfile),
      overrides: Schema.optionalKey(BackgroundActivityOverrides),
    }),
  ),
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  backgroundActivityProfile: Schema.optionalKey(BackgroundActivityProfile),
  environmentIcon: Schema.optionalKey(Schema.NullOr(EnvironmentMachineKind)),
  defaultThreadEnvMode: Schema.optionalKey(Schema.NullOr(ThreadEnvMode)),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  worktreeSubmodules: Schema.optionalKey(Schema.NullOr(WorktreeSubmodules)),
  addProjectBaseDirectory: Schema.optionalKey(TrimmedString),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  branchNamingMode: Schema.optionalKey(BranchNamingMode),
  branchNamePrefix: Schema.optionalKey(TrimmedString),
  branchNameInstructions: Schema.optionalKey(TrimmedString),
  removeAgentCreditsOnMerge: Schema.optionalKey(Schema.Boolean),
  sourceControlWritingStyle: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.optionalKey(SourceControlWritingStyleMode),
      customInstructions: Schema.optionalKey(TrimmedString),
      followChangeRequestTemplates: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  sourceControlWriterModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  reviewGuidesEnabled: Schema.optionalKey(Schema.Boolean),
  reviewGuideModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  reviewGuideInstructions: Schema.optionalKey(TrimmedString),
  pullRequestMergeMethod: Schema.optionalKey(Schema.NullOr(PullRequestMergeMethod)),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(TrimmedString),
      otlpMetricsUrl: Schema.optionalKey(TrimmedString),
      otlpLogsUrl: Schema.optionalKey(TrimmedString),
    }),
  ),
  /**
   * Merges per host: a patched field replaces the saved one, so a client sends a per-server-host
   * map whole, with the redaction marker for each saved secret it keeps. An empty or omitted
   * secret is removed from the secret store.
   */
  sourceControlHosts: Schema.optionalKey(Schema.Record(Schema.String, SourceControlHostSettings)),
  // Whole-map replacement for the new instance config. Patching individual
  // entries is intentionally out of scope: the map is small, and partial
  // patches risk leaving driver-specific config in a half-merged state.
  providerInstances: Schema.optionalKey(Schema.Record(ProviderInstanceId, ProviderInstanceConfig)),
  // Per-entry, unlike `providerInstances`: a client only ever adds or removes
  // one source, and sending the whole map races another edit that has not
  // echoed back yet. `null` removes; the server merges into its current map.
  usageLimitSources: Schema.optionalKey(
    Schema.Record(UsageLimitSourceId, Schema.NullOr(UsageLimitSourceConfig)),
  ),
  cursorKeychainUsageEnabled: Schema.optionalKey(Schema.Boolean),

  usagePriceOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, Schema.NullOr(UsageModelPriceOverride)),
  ),

  usageModelAliases: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, Schema.NullOr(TrimmedNonEmptyString)),
  ),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export function requiredScopesForServerSettingsPatch(
  patch: ServerSettingsPatch,
): ReadonlyArray<AuthEnvironmentScope> {
  let changesProviders = false;
  let changesSettings = false;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "providers" || key === "providerInstances" || key === "usageLimitSources") {
      changesProviders = true;
    } else {
      changesSettings = true;
    }
  }
  return [
    ...(changesSettings || !changesProviders ? [AuthSettingsWriteScope] : []),
    ...(changesProviders ? [AuthProvidersManageScope] : []),
  ];
}

/**
 * Project scripts run on the host when a worktree is created or a thread
 * settles, so a project mutation that carries them needs the same grant as
 * saving project scripts through settings, on top of `orchestration:operate`.
 */
export function requiredScopesForProjectMutation(
  mutation: ProjectMutation,
): ReadonlyArray<AuthEnvironmentScope> {
  if (mutation.type === "project.delete" || mutation.scripts === undefined) {
    return [AuthOrchestrationOperateScope];
  }
  return [
    AuthOrchestrationOperateScope,
    ...requiredScopesForServerSettingsPatch({ defaultProjectScripts: mutation.scripts }),
  ];
}

export const ClientSettingsPatch = Schema.Struct({
  notificationMode: Schema.optionalKey(NotificationMode),
  inAppNotificationsEnabled: Schema.optionalKey(Schema.Boolean),
  diffColorScheme: Schema.optionalKey(DiffColorScheme),
  sidebarSide: Schema.optionalKey(SidebarSide),
  chatWidth: Schema.optionalKey(ChatWidth),
  loadBalancingEnabled: Schema.optionalKey(Schema.Boolean),
  loadBalancingWeights: Schema.optionalKey(LoadBalancingWeights),
  appearanceContrast: Schema.optionalKey(AppearanceContrast),
  panelAnimationDurationMs: Schema.optionalKey(PanelAnimationDurationMs),
  browserDefaultViewport: Schema.optionalKey(PreviewViewportSetting),
  browserDefaultZoomFactor: Schema.optionalKey(PreviewZoomFactor),
  browserDefaultAppearance: Schema.optionalKey(PreviewAppearancePreference),
  browserRecordingFrameRate: Schema.optionalKey(BrowserRecordingFrameRate),
  browserRecordingShowKeyPresses: Schema.optionalKey(Schema.Boolean),
  browserRecordingShowMousePresses: Schema.optionalKey(Schema.Boolean),
  browserLinkTarget: Schema.optionalKey(BrowserLinkTarget),
  browserSearchEngine: Schema.optionalKey(BrowserSearchEngine),
  browserCustomSearchUrl: Schema.optionalKey(BrowserCustomSearchUrl),
  browserAutoShowFloatingPreview: Schema.optionalKey(Schema.Boolean),
  browserProfiles: Schema.optionalKey(Schema.Array(BrowserProfile)),
  browserDefaultProfileId: Schema.optionalKey(BrowserProfileId),
  confirmQuit: Schema.optionalKey(QuitConfirmationMode),
  confirmThreadArchive: Schema.optionalKey(Schema.Boolean),
  confirmThreadDelete: Schema.optionalKey(Schema.Boolean),
  confirmThreadUnpin: Schema.optionalKey(Schema.Boolean),
  diffFilesCollapsed: Schema.optionalKey(Schema.Boolean),
  diffIgnoreWhitespace: Schema.optionalKey(Schema.Boolean),
  diffLayout: Schema.optionalKey(DiffLayout),
  environmentIdentificationMode: Schema.optionalKey(EnvironmentIdentificationMode),
  glassOpacity: Schema.optionalKey(GlassOpacity),
  onboardingCompletedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  fontSizeInterface: Schema.optionalKey(InterfaceFontSize),
  fontSizePrompt: Schema.optionalKey(PromptFontSize),
  fontSizeCode: Schema.optionalKey(CodeFontSize),
  fontSizeTerminal: Schema.optionalKey(TerminalFontSize),
  fontFamilyCode: Schema.optionalKey(FontFamilyPreference),
  fontFamilyComposer: Schema.optionalKey(FontFamilyPreference),
  fontFamilySans: Schema.optionalKey(FontFamilyPreference),
  fontFamilyTerminal: Schema.optionalKey(FontFamilyPreference),
  fontSmoothing: Schema.optionalKey(Schema.Boolean),
  persistComposerContextStrip: Schema.optionalKey(Schema.Boolean),
  favorites: Schema.optionalKey(ModelFavorites),
  providerModelPreferences: Schema.optionalKey(ProviderModelPreferences),
  pullRequestMergeMethodOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, PullRequestMergeMethod),
  ),
  pullRequestLinksOpenInApp: Schema.optionalKey(Schema.Boolean),
  planModeEnabled: Schema.optionalKey(Schema.Boolean),
  contextWindowMeterEnabled: Schema.optionalKey(Schema.Boolean),
  composerCollapseOnScroll: Schema.optionalKey(Schema.Boolean),
  composerRichTextEnabled: Schema.optionalKey(Schema.Boolean),
  sendShortcut: Schema.optionalKey(Schema.Literals(["enter", "mod-enter-multiline", "mod-enter"])),
  followUpBehavior: Schema.optionalKey(Schema.Literals(["queue", "steer"])),
  proactivePanelsEnabled: Schema.optionalKey(Schema.Boolean),
  showSkillsInSlashMenu: Schema.optionalKey(Schema.Boolean),
  legacySidebarEnabled: Schema.optionalKey(Schema.Boolean),
  sidebarWorkingShelfEnabled: Schema.optionalKey(Schema.Boolean),
  sidebarProjectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  sidebarProjectGroupingOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectGroupingMode),
  ),
  sidebarProjectSortOrder: Schema.optionalKey(SidebarProjectSortOrder),
  sidebarThreadSortOrder: Schema.optionalKey(SidebarThreadSortOrder),
  sidebarThreadPreviewCount: Schema.optionalKey(SidebarThreadPreviewCount),
  timestampFormat: Schema.optionalKey(TimestampFormat),
  snapShotEnabled: Schema.optionalKey(Schema.Boolean),
  snapShotIncludeAccessibility: Schema.optionalKey(Schema.Boolean),
  snapShotShortcut: Schema.optionalKey(SnapShotShortcut),
  snapShotPlaySound: Schema.optionalKey(Schema.Boolean),
  snapShotSound: Schema.optionalKey(SnapShotSound),
  snapShotFlash: Schema.optionalKey(Schema.Boolean),
  snapShotAnimations: Schema.optionalKey(Schema.Boolean),
  wordWrap: Schema.optionalKey(Schema.Boolean),
  mathRenderingEnabled: Schema.optionalKey(Schema.Boolean),
});
export type ClientSettingsPatch = typeof ClientSettingsPatch.Type;
