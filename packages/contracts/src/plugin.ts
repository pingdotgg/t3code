// Plugins run as trusted OS-user code; the supervised process boundary is not a sandbox.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PLUGIN_TOOL_LIMITS, PluginToolDeclaration } from "./pluginTools.ts";
import { PluginSettingsDeclaration } from "./pluginSettingFields.ts";
import { PLUGIN_ACTIONS_MAX_PER_PLUGIN, PluginActionDeclaration } from "./pluginActions.ts";
import { PluginTransformsDeclaration } from "./pluginTransforms.ts";
import { PluginApprovalDeclaration } from "./pluginApprovals.ts";

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
  /** Commands for clients to offer; needs the `actions` capability (see PluginActions). */
  actions: Schema.optionalKey(
    Schema.Array(PluginActionDeclaration).check(Schema.isMaxLength(PLUGIN_ACTIONS_MAX_PER_PLUGIN)),
  ),
  /** Run transforms; needs the `transforms` capability (see PluginTransforms). */
  transforms: Schema.optionalKey(PluginTransformsDeclaration),
  /** The approval requests the plugin answers; needs the `approvals` capability (see PluginApprovals). */
  approvals: Schema.optionalKey(PluginApprovalDeclaration),
});
export type PluginManifest = typeof PluginManifest.Type;

const PluginFailureReason = Schema.String.check(Schema.isMaxLength(1000));

// Decode through ForwardCompatibleOptional: an absent state is unknown, never idle or safe to enable.
// Incompatible code and quarantined crashes require explicit resume; ordinary backoff retries automatically.
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
