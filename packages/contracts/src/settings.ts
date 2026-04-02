import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas";
import {
  ClaudeModelOptions,
  CodexModelOptions,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
} from "./model";
import { ModelSelection } from "./orchestration";

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

const makeTrimmedStringSetting = (description: string) =>
  Schema.String.annotate({ description }).pipe(
    Schema.decodeTo(TrimmedString, SchemaTransformation.passthrough()),
  );

export const ClientSettingsSchema = Schema.Struct({
  confirmThreadArchive: Schema.Boolean.annotate({
    description: "Require a second click on the inline archive action before a thread is archived.",
  }).pipe(Schema.withDecodingDefault(() => false)),
  confirmThreadDelete: Schema.Boolean.annotate({
    description: "Ask before deleting a thread and its chat history.",
  }).pipe(Schema.withDecodingDefault(() => true)),
  diffWordWrap: Schema.Boolean.annotate({
    description: "Set the default wrap state when the diff panel opens.",
  }).pipe(Schema.withDecodingDefault(() => false)),
  sidebarProjectSortOrder: SidebarProjectSortOrder.annotate({
    description: "Choose how projects are ordered in the sidebar.",
  }).pipe(Schema.withDecodingDefault(() => DEFAULT_SIDEBAR_PROJECT_SORT_ORDER)),
  sidebarThreadSortOrder: SidebarThreadSortOrder.annotate({
    description: "Choose how threads are ordered inside the selected project.",
  }).pipe(Schema.withDecodingDefault(() => DEFAULT_SIDEBAR_THREAD_SORT_ORDER)),
  timestampFormat: TimestampFormat.annotate({
    description: "System default follows your browser or OS clock preference.",
  }).pipe(Schema.withDecodingDefault(() => DEFAULT_TIMESTAMP_FORMAT)),
}).annotate({
  description: "Client-only settings persisted locally in the browser.",
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

export const ThreadEnvMode = Schema.Literals(["local", "worktree"]).annotate({
  description: "Pick the default workspace mode for newly created draft threads.",
});
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

const makeBinaryPathSetting = (fallback: string, description: string) =>
  makeTrimmedStringSetting(description).pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(() => fallback),
  );

export const CodexSettings = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    description: "Whether the Codex provider is enabled and available for selection.",
  }).pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("codex", "Path to the Codex binary"),
  homePath: makeTrimmedStringSetting("Optional custom Codex home and config directory.").pipe(
    Schema.withDecodingDefault(() => ""),
  ),
  customModels: Schema.Array(Schema.String)
    .annotate({
      description:
        "Additional Codex model slugs to surface in the UI alongside discovered defaults.",
    })
    .pipe(Schema.withDecodingDefault(() => [])),
}).annotate({
  description: "Server-side configuration for the Codex provider.",
});
export type CodexSettings = typeof CodexSettings.Type;

export const ClaudeSettings = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    description: "Whether the Claude provider is enabled and available for selection.",
  }).pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("claude", "Path to the Claude binary"),
  customModels: Schema.Array(Schema.String)
    .annotate({
      description:
        "Additional Claude model slugs to surface in the UI alongside discovered defaults.",
    })
    .pipe(Schema.withDecodingDefault(() => [])),
}).annotate({
  description: "Server-side configuration for the Claude provider.",
});
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.annotate({
    description: "Show token-by-token output while a response is in progress.",
  }).pipe(Schema.withDecodingDefault(() => false)),
  defaultThreadEnvMode: ThreadEnvMode.annotate({
    description: "Pick the default workspace mode for newly created draft threads.",
  }).pipe(Schema.withDecodingDefault(() => "local" as const satisfies ThreadEnvMode)),
  textGenerationModelSelection: ModelSelection.annotate({
    description:
      "Configure the model used for generated commit messages, PR titles, and similar Git text.",
  }).pipe(
    Schema.withDecodingDefault(() => ({
      provider: "codex" as const,
      model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
    })),
  ),

  // Provider specific settings
  providers: Schema.Struct({
    codex: CodexSettings.annotate({
      description: "Configuration for the Codex provider.",
    }).pipe(Schema.withDecodingDefault(() => ({}))),
    claudeAgent: ClaudeSettings.annotate({
      description: "Configuration for the Claude provider.",
    }).pipe(Schema.withDecodingDefault(() => ({}))),
  })
    .annotate({
      description: "Provider-specific server configuration.",
    })
    .pipe(Schema.withDecodingDefault(() => ({}))),
}).annotate({
  description: "Server-authoritative settings persisted in `settings.json`.",
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

const CodexModelOptionsPatch = Schema.Struct({
  reasoningEffort: Schema.optionalKey(CodexModelOptions.fields.reasoningEffort),
  fastMode: Schema.optionalKey(CodexModelOptions.fields.fastMode),
});

const ClaudeModelOptionsPatch = Schema.Struct({
  thinking: Schema.optionalKey(ClaudeModelOptions.fields.thinking),
  effort: Schema.optionalKey(ClaudeModelOptions.fields.effort),
  fastMode: Schema.optionalKey(ClaudeModelOptions.fields.fastMode),
  contextWindow: Schema.optionalKey(ClaudeModelOptions.fields.contextWindow),
});

const ModelSelectionPatch = Schema.Union([
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("codex")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(CodexModelOptionsPatch),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("claudeAgent")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(ClaudeModelOptionsPatch),
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
});

export const ServerSettingsPatch = Schema.Struct({
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
    }),
  ),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;
