import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PLUGIN_MANIFEST_FILE = "t3-plugin.json";

export const PluginId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
).pipe(Schema.brand("PluginId"));
export type PluginId = typeof PluginId.Type;

export const PluginCommandName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
).pipe(Schema.brand("PluginCommandName"));
export type PluginCommandName = typeof PluginCommandName.Type;

const PluginEntryPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^(?!\/)(?!\.)(?!.*\/\.)(?!.*\/\/)[a-zA-Z0-9_./-]+\.html$/),
);

const PluginBackendPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^(?!\/)(?!\.)(?!.*\/\.)(?!.*\/\/)[a-zA-Z0-9_./-]+\.(?:js|mjs)$/),
);

export const PluginViewCommand = Schema.Struct({
  name: PluginCommandName,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  description: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(240))),
  entry: PluginEntryPath,
});
export type PluginViewCommand = typeof PluginViewCommand.Type;

export const PluginManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: PluginId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  description: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(240))),
  backend: Schema.optionalKey(PluginBackendPath),
  commands: Schema.Array(PluginViewCommand).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});
export type PluginManifest = typeof PluginManifest.Type;

/**
 * Directory inside a shared plugin source repository that holds one folder per
 * plugin. A repo can therefore ship several plugins: `plugins/<id>/t3-plugin.json`.
 */
export const PLUGIN_SOURCE_PLUGINS_DIR = "plugins";

export const PluginSourceId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
).pipe(Schema.brand("PluginSourceId"));
export type PluginSourceId = typeof PluginSourceId.Type;

/**
 * Only https/ssh remotes are accepted. The leading-scheme requirement also keeps
 * a URL from being parsed as a git CLI option.
 */
export const PluginSourceGitUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^(?:https:\/\/|ssh:\/\/|git@)[^\s]+$/),
);

export const PluginSource = Schema.Struct({
  id: PluginSourceId,
  gitUrl: Schema.String,
  directory: Schema.String,
  pluginIds: Schema.Array(PluginId),
  issue: Schema.optionalKey(Schema.String),
});
export type PluginSource = typeof PluginSource.Type;

export const PluginCatalogEntry = Schema.Struct({
  ...PluginManifest.fields,
  enabled: Schema.Boolean,
  /** Absent for locally scaffolded plugins; set when the plugin came from a source repo. */
  sourceId: Schema.optionalKey(PluginSourceId),
});
export type PluginCatalogEntry = typeof PluginCatalogEntry.Type;

export const PluginIssue = Schema.Struct({
  directory: Schema.String,
  message: Schema.String,
});
export type PluginIssue = typeof PluginIssue.Type;

export const PluginCatalog = Schema.Struct({
  pluginsDirectory: Schema.String,
  plugins: Schema.Array(PluginCatalogEntry),
  issues: Schema.Array(PluginIssue),
  sources: Schema.Array(PluginSource),
});
export type PluginCatalog = typeof PluginCatalog.Type;

export const PluginCreateInput = Schema.Struct({
  id: PluginId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  description: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(240))),
});
export type PluginCreateInput = typeof PluginCreateInput.Type;

export const PluginSetEnabledInput = Schema.Struct({
  pluginId: PluginId,
  enabled: Schema.Boolean,
});
export type PluginSetEnabledInput = typeof PluginSetEnabledInput.Type;

export const PluginDeleteInput = Schema.Struct({
  pluginId: PluginId,
});
export type PluginDeleteInput = typeof PluginDeleteInput.Type;

export const PluginAddSourceInput = Schema.Struct({
  gitUrl: PluginSourceGitUrl,
});
export type PluginAddSourceInput = typeof PluginAddSourceInput.Type;

export const PluginUpdateSourceInput = Schema.Struct({
  sourceId: PluginSourceId,
});
export type PluginUpdateSourceInput = typeof PluginUpdateSourceInput.Type;

export const PluginRemoveSourceInput = Schema.Struct({
  sourceId: PluginSourceId,
});
export type PluginRemoveSourceInput = typeof PluginRemoveSourceInput.Type;

export const PluginCreateViewUrlInput = Schema.Struct({
  pluginId: PluginId,
  commandName: PluginCommandName,
});
export type PluginCreateViewUrlInput = typeof PluginCreateViewUrlInput.Type;

export const PluginViewUrl = Schema.Struct({
  relativeUrl: Schema.String,
  expiresAt: Schema.Number,
});
export type PluginViewUrl = typeof PluginViewUrl.Type;

export const PluginInvokeInput = Schema.Struct({
  pluginId: PluginId,
  action: TrimmedNonEmptyString.check(
    Schema.isMaxLength(80),
    Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  ),
  inputJson: Schema.String.check(Schema.isMaxLength(256 * 1024)),
});
export type PluginInvokeInput = typeof PluginInvokeInput.Type;

export const PluginInvokeResult = Schema.Struct({
  outputJson: Schema.String.check(Schema.isMaxLength(4 * 1024 * 1024)),
});
export type PluginInvokeResult = typeof PluginInvokeResult.Type;

export class PluginOperationError extends Schema.TaggedErrorClass<PluginOperationError>()(
  "PluginOperationError",
  {
    operation: Schema.Literals([
      "list",
      "create",
      "set-enabled",
      "delete",
      "add-source",
      "update-source",
      "remove-source",
      "create-view-url",
      "invoke",
    ]),
    message: Schema.String,
  },
) {}
