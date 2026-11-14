import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { SecretReference } from "./secretReference.ts";

export const ProfileId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
);

/** Drivers whose harness a profile can configure. Each session reads its own driver's entry. */
export const ProfileProviderSettingsDriver = Schema.Literals(["claudeAgent", "codex", "pi"]);
export type ProfileProviderSettingsDriver = typeof ProfileProviderSettingsDriver.Type;

/** Names of provider settings in `provider-settings.json`, one per driver. */
export const ProfileProviderSettingsRefs = Schema.Struct({
  claudeAgent: Schema.optionalKey(ProfileId),
  codex: Schema.optionalKey(ProfileId),
  pi: Schema.optionalKey(ProfileId),
});
export type ProfileProviderSettingsRefs = typeof ProfileProviderSettingsRefs.Type;

/** Names starting with `t3-code`, `t3_code` or `t3code` are shown as T3's own tools. */
export const ProfileMcpServerName = ProfileId.check(
  Schema.makeFilter((name: string) => !/^t3[-_]?code/i.test(name), {
    expected: "a name that does not start with t3-code",
  }),
);

/** A literal, or a secret reference read on the environment when a session opens. */
export const ProfileMcpValue = Schema.Union([Schema.String, SecretReference]);
export type ProfileMcpValue = typeof ProfileMcpValue.Type;

const McpValues = Schema.Record(TrimmedNonEmptyString, ProfileMcpValue);

/** Shaped like a Claude `.mcp.json` entry, so existing definitions can be pasted in. */
export const ProfileMcpServer = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("http"),
    description: Schema.optionalKey(TrimmedNonEmptyString),
    url: TrimmedNonEmptyString.check(Schema.isPattern(/^https?:\/\/\S+$/)),
    headers: Schema.optionalKey(McpValues),
  }),
  Schema.Struct({
    type: Schema.optionalKey(Schema.Literal("stdio")),
    description: Schema.optionalKey(TrimmedNonEmptyString),
    command: TrimmedNonEmptyString,
    args: Schema.optionalKey(Schema.Array(Schema.String)),
    env: Schema.optionalKey(McpValues),
  }),
]);
export type ProfileMcpServer = typeof ProfileMcpServer.Type;

/** `mcp-servers.json`: MCP servers profiles can add to a session. */
export const McpServersFile = Schema.Struct({
  mcpServers: Schema.Record(ProfileMcpServerName, ProfileMcpServer),
});
export type McpServersFile = typeof McpServersFile.Type;

export const Profile = Schema.Struct({
  description: Schema.optionalKey(TrimmedNonEmptyString),
  prompts: Schema.Array(ProfileId),
  skills: Schema.Array(ProfileId),
  /** Names from `mcp-servers.json`, added to Claude and Codex sessions. */
  mcpServers: Schema.optionalKey(Schema.Array(ProfileMcpServerName)),
  providerSettings: Schema.optionalKey(ProfileProviderSettingsRefs),
  provider: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  effort: Schema.optionalKey(TrimmedNonEmptyString),
});
export type Profile = typeof Profile.Type;

export const ProfilesFile = Schema.Struct({
  default: Schema.optionalKey(ProfileId),
  profiles: Schema.Record(ProfileId, Profile),
});
export type ProfilesFile = typeof ProfilesFile.Type;

const NameList = Schema.Array(TrimmedNonEmptyString);

/** Applied per session through Claude Agent SDK query options; login and binary stay on the instance. */
export const ClaudeProviderSettings = Schema.Struct({
  description: Schema.optionalKey(TrimmedNonEmptyString),
  /** Claude tools the agent may not use (`disallowedTools`). T3's own tools are never blocked. */
  blockedTools: Schema.optionalKey(NameList),
  /** False turns off Claude Code's bundled skills (`disableBundledSkills`). */
  bundledSkills: Schema.optionalKey(Schema.Boolean),
  /** Installed Claude skills turned off for the session (`skillOverrides`). */
  disabledSkills: Schema.optionalKey(NameList),
  /** Installed Claude plugins turned off for the session (`enabledPlugins`). */
  disabledPlugins: Schema.optionalKey(NameList),
  autoMemory: Schema.optionalKey(Schema.Boolean),
  /** False removes Claude's commit and PR attribution. */
  coAuthor: Schema.optionalKey(Schema.Boolean),
  /** Claude in Chrome (`--chrome`). */
  chrome: Schema.optionalKey(Schema.Boolean),
  /** Further Claude Code settings keys. Keys T3 needs are ignored. */
  settings: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
export type ClaudeProviderSettings = typeof ClaudeProviderSettings.Type;

/** Applied as per-thread config at thread start and resume; the shared app-server is unchanged. */
export const CodexProviderSettings = Schema.Struct({
  description: Schema.optionalKey(TrimmedNonEmptyString),
  /** `features.<name>` overrides, from the app-server's experimental feature list. */
  features: Schema.optionalKey(Schema.Record(TrimmedNonEmptyString, Schema.Boolean)),
  /** Codex skills turned off for the thread, where Codex allows that per thread. */
  disabledSkills: Schema.optionalKey(NameList),
  /** Codex plugins turned off for the thread, where Codex allows that per thread. */
  disabledPlugins: Schema.optionalKey(NameList),
  /** Further dotted config keys. Keys T3 needs (its MCP servers, shell policy) are refused. */
  config: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
export type CodexProviderSettings = typeof CodexProviderSettings.Type;

/** Applied as launch flags; Pi runs one process per session. */
export const PiProviderSettings = Schema.Struct({
  description: Schema.optionalKey(TrimmedNonEmptyString),
  /** False passes `--no-skills`. T3's profile skill listing is unaffected. */
  skills: Schema.optionalKey(Schema.Boolean),
  /** False passes `--no-prompt-templates`. */
  promptTemplates: Schema.optionalKey(Schema.Boolean),
});
export type PiProviderSettings = typeof PiProviderSettings.Type;

/** `provider-settings.json`: named settings per driver. */
export const ProviderSettingsFile = Schema.Struct({
  claudeAgent: Schema.optionalKey(Schema.Record(ProfileId, ClaudeProviderSettings)),
  codex: Schema.optionalKey(Schema.Record(ProfileId, CodexProviderSettings)),
  pi: Schema.optionalKey(Schema.Record(ProfileId, PiProviderSettings)),
});
export type ProviderSettingsFile = typeof ProviderSettingsFile.Type;

/** The resolved provider settings a session opens with. */
export const ResolvedProviderSettings = Schema.Union([
  Schema.TaggedStruct("claudeAgent", { id: ProfileId, settings: ClaudeProviderSettings }),
  Schema.TaggedStruct("codex", { id: ProfileId, settings: CodexProviderSettings }),
  Schema.TaggedStruct("pi", { id: ProfileId, settings: PiProviderSettings }),
]);
export type ResolvedProviderSettings = typeof ResolvedProviderSettings.Type;

export const ProfileCatalog = Schema.Struct({
  folder: Schema.String,
  default: Schema.optionalKey(ProfileId),
  profiles: Schema.Record(
    ProfileId,
    Schema.Struct({
      ...Profile.fields,
      warning: Schema.optionalKey(Schema.String),
    }),
  ),
  error: Schema.optionalKey(Schema.String),
});
export type ProfileCatalog = typeof ProfileCatalog.Type;

export const ProfilePrompt = Schema.Struct({ name: ProfileId, content: Schema.String });
export type ProfilePrompt = typeof ProfilePrompt.Type;

/** A skill in `<folder>/.agents/skills/<name>/SKILL.md`. */
export const ProfileSkill = Schema.Struct({
  name: ProfileId,
  description: Schema.optionalKey(Schema.String),
  path: Schema.String,
  /** Source recorded in `skills-lock.json` by `npx skills add`; absent for skills you wrote. */
  source: Schema.optionalKey(Schema.String),
  /** The skill has a package.json but no node_modules on this machine. */
  needsInstall: Schema.optionalKey(Schema.Boolean),
  warning: Schema.optionalKey(Schema.String),
});
export type ProfileSkill = typeof ProfileSkill.Type;

/** Sync bookkeeping for one environment's folder. Kept in `<folder>/.t3-sync.json`, never synced. */
export const ProfilesSyncState = Schema.Struct({
  /** Grows on every change: saves in T3, skill commands, and edits made outside T3. */
  revision: Schema.Int,
  /** Hash of the synced files as they are now. */
  hash: Schema.String,
  /** Hash at the last sync; differs from `hash` while this copy has unsynced changes. */
  syncedHash: Schema.NullOr(Schema.String),
  /** When the content last changed. The latest change wins a sync. */
  updatedAt: Schema.NullOr(Schema.String),
});
export type ProfilesSyncState = typeof ProfilesSyncState.Type;

export const ProfilesEditorState = Schema.Struct({
  folder: Schema.String,
  exists: Schema.Boolean,
  /** Null when `profiles.json` is missing or cannot be decoded; see `error`. */
  profiles: Schema.NullOr(ProfilesFile),
  providerSettings: ProviderSettingsFile,
  // Older servers leave it out.
  mcpServers: Schema.optionalKey(McpServersFile),
  prompts: Schema.Array(ProfilePrompt),
  skills: Schema.Array(ProfileSkill),
  catalog: ProfileCatalog,
  sync: ProfilesSyncState,
  error: Schema.optionalKey(Schema.String),
});
export type ProfilesEditorState = typeof ProfilesEditorState.Type;

export const ProfilesEditorWriteInput = Schema.Struct({
  /** Rejects the write when the folder changed since this revision was read. */
  expectedRevision: Schema.Int,
  // Sync can replace content at the same revision. Older clients omit it.
  expectedHash: Schema.optionalKey(Schema.String),
  profiles: Schema.optionalKey(ProfilesFile),
  providerSettings: Schema.optionalKey(ProviderSettingsFile),
  /** Needs `providers:manage` too: a command server runs on every environment that allows them. */
  mcpServers: Schema.optionalKey(McpServersFile),
  prompts: Schema.optionalKey(
    Schema.Struct({
      upsert: Schema.optionalKey(Schema.Array(ProfilePrompt)),
      remove: Schema.optionalKey(Schema.Array(ProfileId)),
    }),
  ),
});
export type ProfilesEditorWriteInput = typeof ProfilesEditorWriteInput.Type;

export const ProfilesSkillsInput = Schema.Union([
  Schema.TaggedStruct("add", {
    /** `owner/repo`, a GitHub URL, or another source `npx skills add` accepts. */
    source: Schema.NonEmptyString.check(
      Schema.isMaxLength(512),
      Schema.isPattern(/^(?!-)[^\s\x00-\x1f\x7f]+$/),
    ),
    skill: Schema.optionalKey(ProfileId),
  }),
  Schema.TaggedStruct("update", {}),
  Schema.TaggedStruct("remove", { name: ProfileId }),
  /** Installs a synced skill's npm dependencies on this machine (node_modules is never synced). */
  Schema.TaggedStruct("install", { name: ProfileId }),
]);
export type ProfilesSkillsInput = typeof ProfilesSkillsInput.Type;

export const ProfilesSkillsResult = Schema.Struct({
  /** Bounded command output. */
  output: Schema.String,
  state: ProfilesEditorState,
});
export type ProfilesSkillsResult = typeof ProfilesSkillsResult.Type;

const DetectedName = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  /** Whether it is on by default here, when the provider reports it. */
  enabled: Schema.optionalKey(Schema.Boolean),
});

/** What this machine's installed providers offer, for the provider settings forms. */
export const ProviderSettingsOptions = Schema.Struct({
  claudeAgent: Schema.optionalKey(
    Schema.Struct({
      tools: Schema.Array(DetectedName),
      skills: Schema.Array(DetectedName),
      plugins: Schema.Array(DetectedName),
      error: Schema.optionalKey(Schema.String),
    }),
  ),
  codex: Schema.optionalKey(
    Schema.Struct({
      features: Schema.Array(DetectedName),
      skills: Schema.Array(DetectedName),
      plugins: Schema.Array(DetectedName),
      error: Schema.optionalKey(Schema.String),
    }),
  ),
  pi: Schema.optionalKey(
    Schema.Struct({
      skills: Schema.Array(DetectedName),
      promptTemplates: Schema.Array(DetectedName),
      error: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type ProviderSettingsOptions = typeof ProviderSettingsOptions.Type;

export const ProfilesBundleFile = Schema.Struct({
  /** Folder-relative POSIX path. */
  path: Schema.String,
  contentBase64: Schema.String,
  executable: Schema.optionalKey(Schema.Boolean),
});
export type ProfilesBundleFile = typeof ProfilesBundleFile.Type;

export const ProfilesSyncReadInput = Schema.Struct({ includeFiles: Schema.Boolean });
export const ProfilesSyncReadResult = Schema.Struct({
  state: ProfilesSyncState,
  /** False when this environment's sync switch is off; it neither sends nor receives copies. */
  enabled: Schema.Boolean,
  files: Schema.optionalKey(Schema.Array(ProfilesBundleFile)),
  /** Paths left out: node_modules, .git, too large, or not regular files. */
  skipped: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type ProfilesSyncReadResult = typeof ProfilesSyncReadResult.Type;

export const ProfilesSyncWriteInput = Schema.Struct({
  /** Rejects the write when this copy changed since the client read it. */
  expectedRevision: Schema.Int,
  // Sync can replace content at the same revision. Older clients omit it.
  expectedHash: Schema.optionalKey(Schema.String),
  /** `updatedAt` is when the source content last changed; the copy keeps it. */
  source: Schema.Struct({ hash: Schema.String, updatedAt: Schema.NullOr(Schema.String) }),
  files: Schema.Array(ProfilesBundleFile),
});
export const ProfilesSyncWriteResult = Schema.Struct({
  state: ProfilesSyncState,
  /** Where this copy's unsynced changes were saved before being replaced. */
  backupPath: Schema.optionalKey(Schema.String),
});
export type ProfilesSyncWriteResult = typeof ProfilesSyncWriteResult.Type;

/** Marks the source copy as synced at `hash` after it was copied everywhere. */
export const ProfilesSyncMarkInput = Schema.Struct({ hash: Schema.String });

export class ProfilesError extends Schema.TaggedError<ProfilesError>()("ProfilesError", {
  reason: Schema.Literals(["invalid", "conflict", "io", "command", "unavailable"]),
  message: Schema.String,
}) {}
