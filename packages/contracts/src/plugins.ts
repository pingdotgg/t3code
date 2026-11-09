import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Lowercase because the id names the plugin's directory on case-insensitive filesystems. No
// underscores, so the `plg_<id>_` prefix on plugin MCP tool names belongs to exactly one plugin.
export const PluginId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^[a-z][a-z0-9-]*$/),
).pipe(Schema.brand("PluginId"));
export type PluginId = typeof PluginId.Type;

// https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const PluginVersion = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(SEMVER_PATTERN, { expected: "a semver version such as 1.2.3" }),
);

// The syntax `satisfiesSemverRange` in packages/shared/src/semver.ts evaluates. Anything else,
// such as `~1.2`, would never match, so it fails here with a reason instead.
const ENGINE_COMPARATOR = String.raw`(?:\^|>=|>|<=|<|=)?v?\d+(?:\.\d+){0,2}`;
const ENGINE_GROUP = String.raw`${ENGINE_COMPARATOR}(?:\s+${ENGINE_COMPARATOR})*`;
const PluginEngineRange = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(new RegExp(String.raw`^${ENGINE_GROUP}(?:\s*\|\|\s*${ENGINE_GROUP})*$`), {
    expected: "a version range using ^, >=, >, <=, <, = and ||, such as >=0.1.6",
  }),
);

// Lexical check only. Code that reads or serves the file still resolves symlinks.
const isInsidePluginDirectory = Schema.makeFilter(
  (path: string) =>
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/^[a-zA-Z]:/.test(path) &&
    path.split("/").every((segment) => segment !== ".."),
  { expected: "a relative path inside the plugin directory" },
);
const PluginEntryPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  isInsidePluginDirectory,
);

// The packaged server is a Node single executable that can only `require` plugin code, and a
// `.js` file under a `"type": "module"` package.json would load as ESM.
const PluginServerEntryPath = PluginEntryPath.check(
  Schema.isPattern(/\.cjs$/, { expected: "a CommonJS file ending in .cjs" }),
);

/** `t3-plugin.json` at the root of a plugin directory. */
export const PluginManifest = Schema.Struct({
  id: PluginId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  version: PluginVersion,
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  engines: Schema.Struct({ t3: PluginEngineRange }),
  server: Schema.optionalKey(PluginServerEntryPath),
  web: Schema.optionalKey(PluginEntryPath),
  /**
   * JSON Schema for the plugin's settings. Top-level string fields with `format: "t3-secret"` are
   * write-only and kept in the secret store; `t3-secret` anywhere else is saved as plain text.
   */
  settingsSchema: Schema.optionalKey(Schema.JsonObject),
  /** Shown to the user before enabling. Not enforced: plugins are trusted code. */
  permissions: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(200))).check(
      Schema.isMaxLength(32),
    ),
  ),
});
export type PluginManifest = typeof PluginManifest.Type;

/** `dev` is a folder in `devPaths`, loaded where it is. */
export const PluginSource = Schema.Literals(["installed", "dev"]);
export type PluginSource = typeof PluginSource.Type;

export const PluginStatus = Schema.Literals(["active", "disabled", "failed", "loading"]);
export type PluginStatus = typeof PluginStatus.Type;

/**
 * `crash` is a plugin that stopped the server, turned off until the user turns it on again.
 * `duplicate` is an id more than one folder has; none of them runs until one is left. `skipped` is
 * a plugin that is on while the server runs with `--no-plugins`.
 */
export const PluginFailureStage = Schema.Literals([
  "discovery",
  "duplicate",
  "manifest",
  "compatibility",
  "load",
  "activate",
  "crash",
  "skipped",
]);
export type PluginFailureStage = typeof PluginFailureStage.Type;

export const PluginFailure = Schema.Struct({
  stage: PluginFailureStage,
  message: Schema.String,
});
export type PluginFailure = typeof PluginFailure.Type;

/** What the server knows about one discovered plugin, including ones whose manifest failed. */
export const PluginState = Schema.Struct({
  id: PluginId,
  name: TrimmedNonEmptyString,
  /** Absent when the manifest could not be decoded. */
  version: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  permissions: Schema.Array(Schema.String),
  source: PluginSource,
  enabled: Schema.Boolean,
  status: PluginStatus,
  failure: Schema.optionalKey(PluginFailure),
  /** Changes each time the plugin starts, so clients can reload its web half after a restart. */
  revision: Schema.optionalKey(Schema.Number),
  /**
   * Names the contents of its web bundle while it runs. Sent as the bundle URL's `v`, which the
   * server then lets browsers cache for good.
   */
  webRevision: Schema.optionalKey(Schema.String),
  /**
   * The `.css` files in its `styles` folder while it runs, in the order clients apply them. Each
   * `revision` names the file's contents and is sent as its URL's `v`, like `webRevision`.
   */
  styles: Schema.optionalKey(
    Schema.Array(Schema.Struct({ file: Schema.String, revision: Schema.String })),
  ),
  /**
   * The folder it loads from: a `dev` plugin's as plugins.json lists it, an installed one's inside
   * the plugins folder.
   */
  folder: Schema.optionalKey(Schema.String),
  hasServer: Schema.Boolean,
  hasWeb: Schema.Boolean,
  /** Why its server code failed outside a call since it last started, such as in a timer. */
  serverFailure: Schema.optionalKey(Schema.String),
  /** True when its manifest has a `settingsSchema`, which `plugins.settings.get` sends. */
  hasSettings: Schema.Boolean,
  /**
   * Top-level manifest keys this server doesn't read, such as a typo or a key a newer T3 reads. The
   * manifest still loads without them.
   */
  unknownManifestKeys: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type PluginState = typeof PluginState.Type;

export const PluginRpcName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9._-]*$/),
);
export type PluginRpcName = typeof PluginRpcName.Type;

export const PluginListInput = Schema.Struct({});
export type PluginListInput = typeof PluginListInput.Type;

// A row a newer server sends with a status or failure stage this client doesn't know is dropped,
// so the rest of the list still shows.
export const PluginListResult = Schema.Struct({
  plugins: ForwardCompatibleArray(PluginState),
});
export type PluginListResult = typeof PluginListResult.Type;

export const PluginSetEnabledInput = Schema.Struct({
  pluginId: PluginId,
  enabled: Schema.Boolean,
});
export type PluginSetEnabledInput = typeof PluginSetEnabledInput.Type;

export const PluginReloadInput = Schema.Struct({
  pluginId: PluginId,
});
export type PluginReloadInput = typeof PluginReloadInput.Type;

export const PLUGIN_UPLOAD_MAX_FILES = 1_000;
export const PLUGIN_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export const PluginUploadFile = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(1024), isInsidePluginDirectory),
  contents: Schema.Uint8Array,
});
export type PluginUploadFile = typeof PluginUploadFile.Type;

export const PluginUploadFiles = Schema.Array(PluginUploadFile).check(
  Schema.isMaxLength(PLUGIN_UPLOAD_MAX_FILES, {
    message: `A plugin folder can have up to ${PLUGIN_UPLOAD_MAX_FILES} files.`,
  }),
  Schema.makeFilter(
    (files) =>
      files.reduce((total, file) => total + file.contents.byteLength, 0) <= PLUGIN_UPLOAD_MAX_BYTES,
    { message: `A plugin folder can have up to ${PLUGIN_UPLOAD_MAX_BYTES / 1024 / 1024} MB.` },
  ),
);

export const PluginCreateUploadUrlInput = Schema.Struct({});
export type PluginCreateUploadUrlInput = typeof PluginCreateUploadUrlInput.Type;

/**
 * A signed URL, relative to the environment, that takes one plugin folder as multipart form data:
 * a `file` part per file, named with its path through `encodeURIComponent`. It answers with a
 * `PluginMutationResult`, or a status and the reason as text.
 */
export const PluginCreateUploadUrlResult = Schema.Struct({
  relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  expiresAt: Schema.Number,
});
export type PluginCreateUploadUrlResult = typeof PluginCreateUploadUrlResult.Type;

export const PluginRescanInput = Schema.Struct({});
export type PluginRescanInput = typeof PluginRescanInput.Type;

/** A plugin folder on the server, by its absolute path, to load where it is. */
export const PluginLinkInput = Schema.Struct({
  folder: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type PluginLinkInput = typeof PluginLinkInput.Type;

export const PluginUninstallInput = Schema.Struct({
  pluginId: PluginId,
});
export type PluginUninstallInput = typeof PluginUninstallInput.Type;

export const PluginUninstallResult = Schema.Struct({ pluginId: PluginId });
export type PluginUninstallResult = typeof PluginUninstallResult.Type;

export const PluginMutationResult = Schema.Struct({
  plugin: PluginState,
});
export type PluginMutationResult = typeof PluginMutationResult.Type;

export const PluginSettingsGetInput = Schema.Struct({
  pluginId: PluginId,
});
export type PluginSettingsGetInput = typeof PluginSettingsGetInput.Type;

export const PluginSettingsUpdateInput = Schema.Struct({
  pluginId: PluginId,
  patch: Schema.JsonObject,
});
export type PluginSettingsUpdateInput = typeof PluginSettingsUpdateInput.Type;

/** Secret fields read back as the server's redaction marker, never their value. */
export const PluginSettingsResult = Schema.Struct({
  pluginId: PluginId,
  settings: Schema.JsonObject,
});
export type PluginSettingsResult = typeof PluginSettingsResult.Type;

export const PluginSettingsGetResult = Schema.Struct({
  ...PluginSettingsResult.fields,
  settingsSchema: Schema.optionalKey(Schema.JsonObject),
});
export type PluginSettingsGetResult = typeof PluginSettingsGetResult.Type;

export const PluginInvokeInput = Schema.Struct({
  pluginId: PluginId,
  method: PluginRpcName,
  input: Schema.optionalKey(Schema.Json),
});
export type PluginInvokeInput = typeof PluginInvokeInput.Type;

export const PluginInvokeResult = Schema.Struct({
  output: Schema.Json,
});
export type PluginInvokeResult = typeof PluginInvokeResult.Type;

export const PluginSubscribeInput = Schema.Struct({
  pluginId: PluginId,
  channel: PluginRpcName,
});
export type PluginSubscribeInput = typeof PluginSubscribeInput.Type;

export const PluginSubscriptionEvent = Schema.Struct({
  value: Schema.Json,
});
export type PluginSubscriptionEvent = typeof PluginSubscriptionEvent.Type;

export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  message: Schema.String,
  pluginId: Schema.optionalKey(PluginId),
}) {}
