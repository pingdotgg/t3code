import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  ProviderOptionSelections,
} from "./model.ts";
import { ModelSelection, ProviderKind } from "./orchestration.ts";

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

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

export const ThreadCleanupInactiveDays = Schema.Literals([1, 3, 7, 14, 30]);
export type ThreadCleanupInactiveDays = typeof ThreadCleanupInactiveDays.Type;
export const DEFAULT_THREAD_CLEANUP_INACTIVE_DAYS: ThreadCleanupInactiveDays = 1;

const LegacyUiFontScale = Schema.Literals(["small", "default", "large"]);
type LegacyUiFontScale = typeof LegacyUiFontScale.Type;
const LEGACY_UI_FONT_SIZE_BY_SCALE: Record<LegacyUiFontScale, number> = {
  small: 15,
  default: 16,
  large: 17,
};
export const MIN_INTERFACE_FONT_SIZE_PX = 8;
export const MAX_INTERFACE_FONT_SIZE_PX = 32;
const InterfaceFontSizePxSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(MIN_INTERFACE_FONT_SIZE_PX),
).check(Schema.isLessThanOrEqualTo(MAX_INTERFACE_FONT_SIZE_PX));
export const UiFontSizePx = Schema.Union([InterfaceFontSizePxSchema, LegacyUiFontScale]).pipe(
  Schema.decodeTo(
    InterfaceFontSizePxSchema,
    SchemaTransformation.transformOrFail({
      decode: (value) =>
        Effect.succeed(
          typeof value === "number"
            ? value
            : LEGACY_UI_FONT_SIZE_BY_SCALE[value as LegacyUiFontScale],
        ),
      encode: (value) => Effect.succeed(value),
    }),
  ),
);
export type UiFontSizePx = typeof UiFontSizePx.Type;
export const DEFAULT_UI_FONT_SIZE_PX: UiFontSizePx = 16;

const LegacyCodeFontScale = Schema.Literals(["small", "default", "large"]);
type LegacyCodeFontScale = typeof LegacyCodeFontScale.Type;
const LEGACY_CODE_FONT_SIZE_BY_SCALE: Record<LegacyCodeFontScale, number> = {
  small: 13,
  default: 14,
  large: 15,
};
export const CodeFontSizePx = Schema.Union([InterfaceFontSizePxSchema, LegacyCodeFontScale]).pipe(
  Schema.decodeTo(
    InterfaceFontSizePxSchema,
    SchemaTransformation.transformOrFail({
      decode: (value) =>
        Effect.succeed(
          typeof value === "number"
            ? value
            : LEGACY_CODE_FONT_SIZE_BY_SCALE[value as LegacyCodeFontScale],
        ),
      encode: (value) => Effect.succeed(value),
    }),
  ),
);
export type CodeFontSizePx = typeof CodeFontSizePx.Type;
export const DEFAULT_CODE_FONT_SIZE_PX: CodeFontSizePx = 14;

const MacOsFontSmoothingSchema = Schema.Literals(["auto", "grayscale"]);
export const MacOsFontSmoothing = Schema.Union([
  MacOsFontSmoothingSchema,
  Schema.Literal("subpixel"),
]).pipe(
  Schema.decodeTo(
    MacOsFontSmoothingSchema,
    SchemaTransformation.transformOrFail({
      decode: (value) =>
        Effect.succeed(value === "subpixel" ? "auto" : (value as "auto" | "grayscale")),
      encode: (value) => Effect.succeed(value),
    }),
  ),
);
export type MacOsFontSmoothing = typeof MacOsFontSmoothing.Type;
export const DEFAULT_MAC_OS_FONT_SMOOTHING: MacOsFontSmoothing = "auto";

const AppIconPreference = Schema.Literals([
  "default",
  "forma-arc",
  "forma-fluted",
  "forma-foil",
  "forma-blueprint",
]);
const LegacyBuildAppIconId = Schema.Literals(["forma-prod", "forma-dev", "forma-nightly"]);
export const AppIconId = Schema.Union([AppIconPreference, LegacyBuildAppIconId]).pipe(
  Schema.decodeTo(
    AppIconPreference,
    SchemaTransformation.transformOrFail({
      decode: (value) =>
        Effect.succeed(
          value === "forma-prod" || value === "forma-dev" || value === "forma-nightly"
            ? "default"
            : value,
        ),
      encode: (value) => Effect.succeed(value),
    }),
  ),
);
export type AppIconId = typeof AppIconId.Type;
export const DEFAULT_APP_ICON_ID: AppIconId = "default";

export const ClientSettingsSchema = Schema.Struct({
  appIcon: AppIconId.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_APP_ICON_ID))),
  autoOpenPlanSidebar: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  desktopNotifyOnApprovalRequests: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  desktopNotifyOnUserInputRequests: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  uiFontScale: UiFontSizePx.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_UI_FONT_SIZE_PX)),
  ),
  codeFontScale: CodeFontSizePx.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CODE_FONT_SIZE_PX)),
  ),
  macOsFontSmoothing: MacOsFontSmoothing.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_MAC_OS_FONT_SMOOTHING)),
  ),
  threadCleanupInactiveDays: ThreadCleanupInactiveDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_THREAD_CLEANUP_INACTIVE_DAYS)),
  ),
  diffWordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  favorites: Schema.Array(
    Schema.Struct({
      provider: ProviderKind,
      model: TrimmedNonEmptyString,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
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
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export const CodexSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  binaryPath: makeBinaryPathSetting("codex"),
  homePath: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type CodexSettings = typeof CodexSettings.Type;

export const ClaudeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  binaryPath: makeBinaryPathSetting("claude"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  launchArgs: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const CursorSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  binaryPath: makeBinaryPathSetting("agent"),
  apiEndpoint: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type CursorSettings = typeof CursorSettings.Type;

export const GrokSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  binaryPath: makeBinaryPathSetting("grok"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type GrokSettings = typeof GrokSettings.Type;

export const OpenCodeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  binaryPath: makeBinaryPathSetting("opencode"),
  serverUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  serverPassword: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type OpenCodeSettings = typeof OpenCodeSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const SafetySettings = Schema.Struct({
  protectedFilesystemPathsEnabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
});
export type SafetySettings = typeof SafetySettings.Type;

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("local" as const satisfies ThreadEnvMode)),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        provider: "codex" as const,
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
      }),
    ),
  ),

  // Provider specific settings
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    cursor: CursorSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    grok: GrokSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    opencode: OpenCodeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  safety: SafetySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Server settings error at ${this.settingsPath}: ${this.detail}`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const ModelSelectionPatch = Schema.Union([
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("codex")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(ProviderOptionSelections),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("claudeAgent")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(ProviderOptionSelections),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("cursor")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(ProviderOptionSelections),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("grok")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(ProviderOptionSelections),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("opencode")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(ProviderOptionSelections),
  }),
]);

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  homePath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  launchArgs: Schema.optionalKey(Schema.String),
});

const CursorSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  apiEndpoint: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const GrokSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const OpenCodeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  serverUrl: Schema.optionalKey(Schema.String),
  serverPassword: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const ServerSettingsPatch = Schema.Struct({
  // Server settings
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  addProjectBaseDirectory: Schema.optionalKey(Schema.String),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(Schema.String),
      otlpMetricsUrl: Schema.optionalKey(Schema.String),
    }),
  ),
  safety: Schema.optionalKey(
    Schema.Struct({
      protectedFilesystemPathsEnabled: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
      cursor: Schema.optionalKey(CursorSettingsPatch),
      grok: Schema.optionalKey(GrokSettingsPatch),
      opencode: Schema.optionalKey(OpenCodeSettingsPatch),
    }),
  ),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export const ClientSettingsPatch = Schema.Struct({
  appIcon: Schema.optionalKey(AppIconId),
  autoOpenPlanSidebar: Schema.optionalKey(Schema.Boolean),
  confirmThreadArchive: Schema.optionalKey(Schema.Boolean),
  confirmThreadDelete: Schema.optionalKey(Schema.Boolean),
  desktopNotifyOnApprovalRequests: Schema.optionalKey(Schema.Boolean),
  desktopNotifyOnUserInputRequests: Schema.optionalKey(Schema.Boolean),
  uiFontScale: Schema.optionalKey(UiFontSizePx),
  codeFontScale: Schema.optionalKey(CodeFontSizePx),
  macOsFontSmoothing: Schema.optionalKey(MacOsFontSmoothing),
  threadCleanupInactiveDays: Schema.optionalKey(ThreadCleanupInactiveDays),
  diffWordWrap: Schema.optionalKey(Schema.Boolean),
  favorites: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        provider: ProviderKind,
        model: TrimmedNonEmptyString,
      }),
    ),
  ),
  sidebarProjectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  sidebarProjectGroupingOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectGroupingMode),
  ),
  sidebarProjectSortOrder: Schema.optionalKey(SidebarProjectSortOrder),
  sidebarThreadSortOrder: Schema.optionalKey(SidebarThreadSortOrder),
  timestampFormat: Schema.optionalKey(TimestampFormat),
});
export type ClientSettingsPatch = typeof ClientSettingsPatch.Type;
