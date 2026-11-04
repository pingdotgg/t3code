// Opaque action ids pin registration generations; stale clicks never reach a newer registration.
// Declarations belong to consented manifests; listing them never starts a plugin.
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  ForwardCompatibleArray,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const PLUGIN_ACTIONS_MAX_PER_PLUGIN = 16;
/** The most actions one environment offers at once, across all its plugins. */
export const PLUGIN_ACTIONS_MAX_PER_ENVIRONMENT = 128;
/** The most bytes a snapshot's UTF-8 JSON encoding takes. */
export const PLUGIN_ACTIONS_SNAPSHOT_MAX_BYTES = 128 * 1024;
const PLUGIN_ACTION_NAME_MAX_LENGTH = 48;
const PLUGIN_ACTION_TITLE_MAX_LENGTH = 60;
const PLUGIN_ACTION_DESCRIPTION_MAX_LENGTH = 240;
export const PLUGIN_ACTION_MESSAGE_MAX_LENGTH = 500;

/** Unique within one plugin; also the slash command, `/<name>`. */
const PluginActionName = Schema.String.check(
  Schema.isMaxLength(PLUGIN_ACTION_NAME_MAX_LENGTH),
  Schema.isPattern(/^[a-z][a-z0-9-]*$/),
);

/** What the action runs against. The client supplies the matching target when it invokes. */
const PluginActionTargetKind = Schema.Literals(["environment", "project", "thread"]);

/** Where clients offer the action. Clients ignore placements they do not know. */
const PluginActionPlacement = Schema.Literals(["command-palette", "thread-menu", "composer-slash"]);
export type PluginActionPlacement = typeof PluginActionPlacement.Type;
const isPluginActionPlacement = Schema.is(PluginActionPlacement);

/**
 * Placements as sent to clients; a placement this client does not know is
 * dropped by itself. `ForwardCompatibleArray` cannot do this here: nested in
 * the actions array, dropping one placement would drop the whole action.
 */
const OfferedPluginActionPlacements = Schema.Array(Schema.String).pipe(
  Schema.decodeTo(
    Schema.Array(PluginActionPlacement),
    SchemaTransformation.transform<ReadonlyArray<PluginActionPlacement>, ReadonlyArray<string>>({
      decode: (placements) => placements.filter(isPluginActionPlacement),
      encode: (placements) => placements,
    }),
  ),
);

/** One entry of the manifest's `actions` array. */
export const PluginActionDeclaration = Schema.Struct({
  name: PluginActionName,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(PLUGIN_ACTION_TITLE_MAX_LENGTH)),
  description: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(PLUGIN_ACTION_DESCRIPTION_MAX_LENGTH)),
  ),
  target: PluginActionTargetKind,
  placements: Schema.Array(PluginActionPlacement).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PluginActionPlacement.literals.length),
  ),
});

/** Opaque and server-issued. Clients pass it back unchanged and never parse it. */
export const PluginActionId = TrimmedNonEmptyString.check(Schema.isMaxLength(256)).pipe(
  Schema.brand("PluginActionId"),
);
export type PluginActionId = typeof PluginActionId.Type;

const PluginAction = Schema.Struct({
  id: PluginActionId,
  /** Display only: the manifest's plugin id and name. */
  pluginId: Schema.String,
  pluginName: Schema.String,
  name: Schema.String,
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
  target: PluginActionTargetKind,
  placements: OfferedPluginActionPlacements,
});
export type PluginAction = typeof PluginAction.Type;

// Snapshots replace earlier frames and include whole plugins until the first limit is reached.
// Omitted plugins cannot run actions; later plugins are omitted with them.
export const PluginActionsSnapshot = Schema.Struct({
  actions: ForwardCompatibleArray(PluginAction),
  /** Present only when plugins were left out. */
  omitted: Schema.optionalKey(Schema.Struct({ plugins: NonNegativeInt, actions: NonNegativeInt })),
});
export type PluginActionsSnapshot = typeof PluginActionsSnapshot.Type;

const PluginActionTarget = Schema.Union([
  Schema.TaggedStruct("environment", {}),
  Schema.TaggedStruct("project", { projectId: ProjectId }),
  Schema.TaggedStruct("thread", { threadId: ThreadId }),
]);
export type PluginActionTarget = typeof PluginActionTarget.Type;

export const PluginActionInvokeInput = Schema.Struct({
  actionId: PluginActionId,
  /** Must be the kind the action declares. */
  target: PluginActionTarget,
});
export type PluginActionInvokeInput = typeof PluginActionInvokeInput.Type;

export const PluginActionInvokeResult = Schema.Struct({
  /** What the plugin wants the user to read, one bounded string; null when it said nothing. */
  message: Schema.NullOr(Schema.String),
});
export type PluginActionInvokeResult = typeof PluginActionInvokeResult.Type;

/**
 * `reason` is an open set so newer servers can add cases: `not-found` (no
 * such action now), `stale` (the plugin was enabled again since the list was
 * sent), `target-mismatch`, `target-not-found`, `unavailable`, `busy`,
 * `timeout`, `stopped`, `failed` (the plugin threw; `message` is its own).
 */
export class PluginActionError extends Schema.TaggedError<PluginActionError>()(
  "PluginActionError",
  {
    reason: Schema.String,
    message: Schema.String,
  },
) {}
