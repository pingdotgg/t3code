/**
 * Plugin - Schemas for trusted local plugins run by the environment server.
 *
 * A plugin is a directory with a `t3-plugin.json` manifest and one JavaScript
 * entry module. The server runs each enabled plugin in its own supervised
 * child process, started lazily on first use. Plugins are trusted OS-user
 * code: the child process is an availability boundary, not a sandbox.
 *
 * @module Plugin
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PLUGIN_TOOL_LIMITS, PluginToolDeclaration } from "./pluginTools.ts";
import { PluginSettingsDeclaration } from "./pluginSettingFields.ts";

/**
 * The one plugin API version this server implements. A manifest names the
 * version it was written against; any other value is not loaded. Additive
 * changes keep the version, removals and meaning changes bump it. New APIs
 * ship under the manifest's `proposedApi` opt-in first.
 */
export const PLUGIN_API_VERSION = 1;

export const PLUGIN_MANIFEST_FILE = "t3-plugin.json";

/** Owner-qualified id such as `acme.notifier`: two or more lowercase dot segments. */
export const PluginId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/),
).pipe(Schema.brand("PluginId"));
export type PluginId = typeof PluginId.Type;

/**
 * A capability the plugin asks the host for. The host refuses to load a plugin
 * that declares a capability it does not implement, so a plugin never runs
 * with a silently missing feature.
 */
const PluginCapabilityName = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/),
);
export type PluginCapabilityName = typeof PluginCapabilityName.Type;

/** Relative `.js` or `.mjs` path inside the plugin directory, without `..` segments. */
const PluginEntryPath = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\:\0]+\.m?js$/),
);

export const PluginManifest = Schema.Struct({
  id: PluginId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  /** Display identity of the installed bytes; the host does not order versions. */
  version: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  apiVersion: Schema.Int,
  entry: PluginEntryPath,
  capabilities: Schema.Array(PluginCapabilityName)
    .check(Schema.isMaxLength(32))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Opts into APIs that may change or disappear without an API version bump. */
  proposedApi: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Tools for agents; needs the `tools` capability (see PluginTools). */
  tools: Schema.optionalKey(
    Schema.Array(PluginToolDeclaration).check(
      Schema.isMaxLength(PLUGIN_TOOL_LIMITS.maxToolsPerPlugin),
    ),
  ),
  /** Fields users can set for this plugin; needs the `settings` capability. */
  settings: Schema.optionalKey(PluginSettingsDeclaration),
});
export type PluginManifest = typeof PluginManifest.Type;

const PluginFailureReason = Schema.String.check(Schema.isMaxLength(1000));

/**
 * Runtime state of one enabled plugin's child process. `idle` means no child
 * runs: either it has not been needed yet or it stopped cleanly. After a
 * crash the plugin waits in `backoff` and becomes `idle` again at `retryAt`;
 * too many consecutive failures park it in `quarantined` until someone resumes
 * it explicitly. `incompatible` means the plugin's code cannot run on any
 * server of this version (for example it uses top-level await); it does not
 * count as a failure and also waits for an explicit resume.
 *
 * Clients must decode this through `ForwardCompatibleOptional` and treat an
 * absent value as unknown: never as idle, disabled, or safe to enable.
 */
export const PluginHostState = Schema.Union([
  Schema.TaggedStruct("idle", {}),
  Schema.TaggedStruct("starting", {}),
  Schema.TaggedStruct("running", {}),
  Schema.TaggedStruct("backoff", {
    failures: NonNegativeInt,
    reason: PluginFailureReason,
    retryAt: IsoDateTime,
  }),
  Schema.TaggedStruct("quarantined", {
    failures: NonNegativeInt,
    reason: PluginFailureReason,
  }),
  Schema.TaggedStruct("incompatible", { reason: PluginFailureReason }),
]);
export type PluginHostState = typeof PluginHostState.Type;
