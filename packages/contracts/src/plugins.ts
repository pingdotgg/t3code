import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Plugin identities stay open so locally authored extensions need no core release. */
export const PluginId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/),
);
export type PluginId = typeof PluginId.Type;

/** Entry files are relative to the plugin directory, never URLs or parent paths. */
export const PluginEntryPath = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\u0000?#:]+$/),
);

const PluginMetadataUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:"
        ? true
        : "Plugin metadata URLs must use HTTP(S).";
    } catch {
      return "Plugin metadata URLs must be well-formed HTTP(S) URLs.";
    }
  }),
);

export const PluginManifest = Schema.Struct({
  id: PluginId,
  apiVersion: Schema.Literal(1),
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  description: Schema.optionalKey(Schema.String),
  iconUrl: Schema.optionalKey(PluginMetadataUrl),
  sourceUrl: Schema.optionalKey(PluginMetadataUrl),
  entries: Schema.optionalKey(
    Schema.Struct({
      web: Schema.optionalKey(PluginEntryPath),
      server: Schema.optionalKey(PluginEntryPath),
      mobile: Schema.optionalKey(PluginEntryPath),
      desktop: Schema.optionalKey(PluginEntryPath),
    }),
  ),
  /** Host-granted capabilities; a declaration alone does not isolate code. */
  permissions: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type PluginManifest = typeof PluginManifest.Type;

/** Client-wide services require an explicit permission beyond environment-scoped services. */
export const CLIENT_HOST_SERVICES_PERMISSION = "client:host-services";

export const PluginStatus = Schema.Struct({
  manifest: PluginManifest,
  source: Schema.Literals(["builtin", "local", "registry"]),
  enabled: Schema.Boolean,
  status: Schema.Literals(["active", "disabled", "error"]),
  revision: NonNegativeInt,
  error: Schema.optionalKey(Schema.String),
  /** Captured immutable plugin tree; device approvals bind to these bytes. */
  contentSha256: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  /** Local authoring directory eligible for explicit hot-reload approval. */
  localDevelopmentDirectory: Schema.optionalKey(TrimmedNonEmptyString),
  /** Resolved by the environment host, relative to its authenticated origin. */
  clientModuleUrl: Schema.optionalKey(Schema.String),
  /** Immutable declarative native entry, fetched from the owning environment. */
  mobileModuleUrl: Schema.optionalKey(Schema.String),
});
export type PluginStatus = typeof PluginStatus.Type;

export const PluginSnapshot = Schema.Struct({
  revision: NonNegativeInt,
  plugins: Schema.Array(PluginStatus),
});
export type PluginSnapshot = typeof PluginSnapshot.Type;

export const PluginListInput = Schema.Struct({ query: Schema.optionalKey(Schema.String) });
export type PluginListInput = typeof PluginListInput.Type;
export const PluginSearchInput = PluginListInput;
export type PluginSearchInput = PluginListInput;

export const PluginSetEnabledInput = Schema.Struct({ id: PluginId, enabled: Schema.Boolean });
export type PluginSetEnabledInput = typeof PluginSetEnabledInput.Type;
export const PluginReloadInput = Schema.Struct({ id: Schema.optionalKey(PluginId) });
export type PluginReloadInput = typeof PluginReloadInput.Type;

/** Extension-owned methods validate their own input and output inside this envelope. */
export const PluginInvokeInput = Schema.Struct({
  id: PluginId,
  method: TrimmedNonEmptyString,
  input: Schema.optionalKey(Schema.Unknown),
});
export type PluginInvokeInput = typeof PluginInvokeInput.Type;
export const PluginInvokeResult = Schema.Struct({ output: Schema.Unknown });
export type PluginInvokeResult = typeof PluginInvokeResult.Type;

export const PluginAuthoringTopic = Schema.Literals([
  "overview",
  "thread-panel",
  "composer-banner",
  "working-timer",
  "feature",
  "service",
  "provider",
]);
export const PluginAuthoringGuideInput = Schema.Struct({
  topic: Schema.optionalKey(PluginAuthoringTopic),
  id: Schema.optionalKey(PluginId),
});
export type PluginAuthoringGuideInput = typeof PluginAuthoringGuideInput.Type;

export const PluginAuthoringGuide = Schema.Struct({
  apiVersion: Schema.Literal(1),
  pluginDirectory: Schema.String,
  workflow: Schema.Array(Schema.String),
  rules: Schema.Array(Schema.String),
  components: Schema.Array(Schema.Struct({ api: Schema.String, purpose: Schema.String })),
  recipes: Schema.Array(
    Schema.Struct({
      topic: PluginAuthoringTopic,
      purpose: Schema.String,
      permissions: Schema.Array(Schema.String),
      notes: Schema.Array(Schema.String),
      files: Schema.Array(Schema.Struct({ path: PluginEntryPath, content: Schema.String })),
    }),
  ),
  services: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      pluginId: Schema.String,
      members: Schema.Array(Schema.String),
      bindings: NonNegativeInt,
      enabled: Schema.Boolean,
      lifecycle: Schema.Boolean,
      scopes: Schema.Array(Schema.String),
    }),
  ),
});
export type PluginAuthoringGuide = typeof PluginAuthoringGuide.Type;

export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  message: Schema.String,
  id: Schema.optionalKey(PluginId),
}) {}

/** Bundled feature identities are shared across hosts; implementation stays in each client. */
export const BUILTIN_PLUGIN_MANIFESTS: readonly PluginManifest[] = (
  [
    ["t3.chat", "Chat"],
    ["t3.markdown", "Markdown"],
    ["t3.sidebar", "Sidebar"],
    ["t3.thread", "Thread"],
    ["t3.settings", "Settings"],
    ["t3.diff", "Diff"],
    ["t3.preview", "Browser preview"],
    ["t3.canvas", "Design canvas"],
    ["t3.file-preview", "File preview"],
    ["t3.pull-requests", "Pull requests"],
    ["t3.usage", "Usage"],
    ["t3.connections", "Connections"],
    ["t3.providers", "Provider management"],
    ["t3.provider.codex", "Codex"],
    ["t3.provider.claudeagent", "Claude"],
    ["t3.provider.cursor", "Cursor"],
    ["t3.provider.grok", "Grok"],
    ["t3.provider.opencode", "OpenCode"],
    ["t3.provider.antigravity", "Antigravity"],
    ["t3.provider.pi", "Pi"],
    ["t3.provider.acpregistry", "ACP registry"],
    ["t3.ui", "Interface"],
    ["t3.persistence", "Persistence"],
    ["t3.auth", "Authentication"],
    ["t3.http", "HTTP transport"],
    ["t3.mcp", "Agent tools"],
    ["t3.scheduler", "Scheduling"],
    ["t3.git", "Source control"],
    ["t3.terminal", "Terminal"],
    ["t3.projects", "Projects"],
    ["t3.server", "Server runtime"],
    ["t3.client", "Client runtime"],
    ["t3.desktop", "Desktop runtime"],
    ["t3.mobile", "Native client"],
  ] as const
).map(([id, name]) => ({
  id,
  name,
  apiVersion: 1 as const,
  version: "1.0.0",
  sourceUrl: "https://github.com/pingdotgg/t3code",
  ...(id === "t3.canvas"
    ? { permissions: ["ui", "actions"] }
    : id.startsWith("t3.provider.")
      ? { permissions: ["server:providers"] }
      : {}),
}));
